import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../auth/session';
import { logger } from '../logger';
import { runAgent } from '../orchestrator/engine';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { AgentCache } from '../chat/agent-cache';
import { schedulePlatformEvent } from '../salesforce/callback';
import type { AgentExecuteRequest, AgentExecuteResponse } from '../types';

export const agentRouter = Router();

/**
 * Autonomous (non-chat) execution — record triggers, scheduled runs, Flow's
 * AgentRunner invocable, and the builder's "Test run" all land here.
 *
 * sessionAuth (Bearer <OrgInstall.sessionKey>) replaces the old per-request
 * JWT: orgId comes from the verified session, never trusted from the body,
 * and the run executes through THIS org's own Salesforce connection
 * (getOrgConnection) instead of one shared bootstrap user — the same
 * multi-tenancy boundary chat already uses.
 */
const executeSchema = z.object({
  agentApiName: z.string().min(1),
  recordId: z.string().min(1),
  userId: z.string().min(1),
  runMode: z.enum(['sync', 'async']).default('sync'),
  inputPayload: z.record(z.unknown()).default({}),
  department: z.string().optional(),
  // Running user's AI Engine Connection key, resolved by Apex — same
  // per-request credential pattern chat already uses.
  engineOverride: z.object({
    engineType:   z.string().nullish(),
    apiKey:       z.string().nullish(),
    endpoint:     z.string().nullish(),
    defaultModel: z.string().nullish(),
    connectionId: z.string().nullish(),
  }).optional(),
  isTestRun: z.boolean().optional().default(false),
});

agentRouter.post('/api/agent/execute', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const parsed = executeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    return;
  }
  const request: AgentExecuteRequest = { ...parsed.data, orgId };
  const traceLogger = logger.child({ orgId, agentApiName: request.agentApiName, recordId: request.recordId });

  try {
    const conn = await getOrgConnection(orgId);
    const agent = await AgentCache.load(orgId, request.agentApiName, conn);
    if (!agent) {
      res.status(404).json({ error: 'agent_not_found', agentApiName: request.agentApiName, message: `Agent "${request.agentApiName}" was not found.` });
      return;
    }
    if (agent.status !== 'Active' && !request.isTestRun) {
      res.status(409).json({ error: 'agent_not_active', status: agent.status, message: `Agent is ${agent.status}, not Active — activate it before running it outside the Test Runner.` });
      return;
    }
    if (agent.status === 'Inactive') {
      res.status(409).json({ error: 'agent_inactive', status: agent.status, message: 'Agent is Inactive and cannot be run.' });
      return;
    }

    if (request.runMode === 'async') {
      // Acknowledge immediately, run in background, push result via Platform Event.
      const correlationId = `async-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ack: AgentExecuteResponse = {
        success: true,
        correlationId,
        agentStatus: 'QUEUED',
      };
      res.status(202).json(ack);

      // Fire-and-forget
      runAgent({ agent, request, conn })
        .then((result) => {
          traceLogger.info({ correlationId: result.correlationId, durationMs: result.durationMs }, 'async_run_complete');
          return schedulePlatformEvent({
            orgId,
            agentApiName: request.agentApiName,
            recordId: request.recordId,
            result,
          });
        })
        .catch((err) => {
          traceLogger.error({ err }, 'async_run_failed');
        });
      return;
    }

    // Sync path
    const result = await runAgent({ agent, request, conn });
    const response: AgentExecuteResponse = {
      success: result.success,
      correlationId: result.correlationId,
      agentScore: result.agentScore,
      agentPriority: result.agentPriority,
      agentReason: result.agentReason,
      agentStatus: result.agentStatus,
      agentOutputPayload: JSON.stringify(result.agentOutputPayload),
      toolsUsed: result.toolsUsed.join(','),
      runId: result.runId,
    };
    res.json(response);
  } catch (err) {
    traceLogger.error({ err }, 'execute_failed');
    res.status(500).json({ error: 'execution_failed', message: (err as Error).message });
  }
});

/**
 * Status lookup — for async runs, SF polls this with the correlationId
 * until the Platform Event lands. Keeps the API simple if a customer
 * can't subscribe to platform events.
 */
agentRouter.get('/api/agent/status/:correlationId', sessionAuth, async (req, res) => {
  // In a real system this would query a result store (Redis/postgres).
  // Phase 3 adds a persisted AgentRun table this can read from directly.
  res.json({
    correlationId: req.params.correlationId,
    note: 'For async results subscribe to the AgentExecutionResult__e Platform Event in Salesforce.',
  });
});

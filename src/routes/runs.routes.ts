/**
 * Durable-run resume API — sessionAuth, org-scoped.
 *
 * Approvals call this via AgentApprovalController.decide(); the poller
 * (scheduler/run-poller.ts) calls resumeRunById directly in-process for
 * waits (no HTTP round trip needed there).
 */
import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../auth/session';
import { logger } from '../logger';
import { resumeRunById } from '../orchestrator/engine';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { AgentCache } from '../chat/agent-cache';
import { RunsRepo } from '../db/runs.repo';
import { schedulePlatformEvent } from '../salesforce/callback';
import type { AgentExecuteResponse } from '../types';

export const runsRouter = Router();

/**
 * Per-node trace for a run — what Execution Logs' "Node detail" view
 * fetches. Looked up by correlationId since that's the one identifier
 * Salesforce's AgentExecution__c already stores (there's no AgentRun.Id
 * on the Salesforce side).
 */
runsRouter.get('/api/agent/runs/by-correlation/:correlationId/steps', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const correlationId = req.params.correlationId;
  try {
    const run = await RunsRepo.getByCorrelationId(orgId, correlationId);
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    const steps = await RunsRepo.listSteps(run.id);
    res.json({
      status: run.status,
      steps: steps.map((s) => ({
        nodeId: s.nodeId,
        nodeLabel: s.nodeLabel,
        nodeSubType: s.nodeSubType,
        input: s.input,
        success: s.success,
        output: s.output,
        error: s.error,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
      })),
    });
  } catch (err) {
    logger.error({ err, orgId, correlationId }, 'run_steps_fetch_failed');
    res.status(500).json({ error: 'run_steps_failed', message: (err as Error).message });
  }
});

const resumeSchema = z.object({
  runId: z.string().min(1).optional(),
  approvalToken: z.string().min(1).optional(),
  // Generic hook for a customer's OWN automation (their own Flow/Trigger/
  // Apex reacting to their own Approval Process's outcome however they've
  // set it up) — Archon only submits records for approval, it doesn't ship
  // any decision-detection mechanism of its own. Looking up by record id is
  // the easiest key for someone else's automation to have on hand.
  recordId: z.string().min(1).optional(),
  decision: z.enum(['approved', 'rejected']).optional(),
}).refine((d) => !!d.runId || !!d.approvalToken || !!d.recordId, { message: 'runId, approvalToken, or recordId required' });

runsRouter.post('/api/agent/runs/resume', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const parsed = resumeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    return;
  }
  const { approvalToken, recordId, decision } = parsed.data;

  try {
    let runId = parsed.data.runId;
    if (!runId && approvalToken) {
      const run = await RunsRepo.getByApprovalToken(approvalToken);
      if (!run || run.orgId !== orgId) {
        res.status(404).json({ error: 'run_not_found' });
        return;
      }
      runId = run.id;
    }
    if (!runId && recordId) {
      const run = await RunsRepo.getPendingApprovalByRecord(orgId, recordId);
      if (!run) {
        res.status(404).json({ error: 'run_not_found' });
        return;
      }
      runId = run.id;
    }
    if (!runId) {
      res.status(400).json({ error: 'run_not_found' });
      return;
    }

    const run = await RunsRepo.getById(orgId, runId);
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    if (run.status === 'WAITING_APPROVAL' && !decision) {
      res.status(400).json({ error: 'decision_required', message: 'decision must be "approved" or "rejected" to resume an approval-paused run.' });
      return;
    }

    const conn = await getOrgConnection(orgId);
    const agent = await AgentCache.load(orgId, run.agentApiName, conn);
    if (!agent) {
      res.status(404).json({ error: 'agent_not_found', agentApiName: run.agentApiName });
      return;
    }

    const result = await resumeRunById({ orgId, runId: run.id, agent, conn, decision });

    // Same reasoning as the poller's wait-resume path — the caller here is
    // AgentApprovalController.decide(), which only persists AgentApproval__c,
    // not AgentExecution__c. Push the outcome via platform event so the
    // Execution Log reflects the real post-resume status instead of staying
    // on WAITING_APPROVAL forever.
    schedulePlatformEvent({
      orgId,
      agentApiName: run.agentApiName,
      recordId: run.recordId ?? '',
      result,
    }).catch((err) => logger.error({ err, runId: run.id }, 'run_resume_platform_event_failed'));

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
    logger.error({ err, orgId }, 'run_resume_failed');
    res.status(500).json({ error: 'resume_failed', message: (err as Error).message });
  }
});

/**
 * Chat routes. SessionAuth — every request must be from a configured org.
 *
 *   POST /api/chat/turn
 *     Body: { agentApiName, sessionId, history:[...], newUserMessage, context:{userId, recordContextId?, recordContextType?} }
 *     Returns: { status:'complete', assistantText, toolCalls, modelUsed, tokensIn, tokensOut }
 *
 *   (The old /api/chat/approve-tool endpoint was removed with the Managed MCP
 *   refactor — Anthropic / OpenAI now execute tools directly, no approval pause.)
 */
import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../auth/session';
import { logger } from '../logger';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { AgentCache } from '../chat/agent-cache';
import { runChatTurn } from '../chat/chat-engine';

export const chatRouter = Router();

const turnSchema = z.object({
  agentApiName: z.string().min(1),
  sessionId:    z.string().min(1),
  // Allow empty text when there are attachments only.
  newUserMessage: z.string().max(20_000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant', 'tool', 'system']),
    content: z.string(),
    toolCallsJson: z.string().nullish(),
    toolResultsJson: z.string().nullish(),
    toolCallId: z.string().nullish(),
  })).default([]),
  attachments: z.array(z.object({
    contentDocumentId: z.string().min(15),
    contentVersionId:  z.string().min(15).optional(),
    fileName:          z.string().optional(),
    mimeType:          z.string().optional(),
    fileType:          z.string().optional(),
    fileExtension:     z.string().optional(),
  })).optional(),
  engineOverride: z.object({
    engineType:   z.string().nullish(),
    apiKey:       z.string().nullish(),
    endpoint:     z.string().nullish(),
    defaultModel: z.string().nullish(),
    connectionId: z.string().nullish(),
  }).optional(),
  connectors: z.array(z.object({
    provider:     z.string().min(1),
    mcpServerUrl: z.string().url(),
    allowedTools: z.array(z.string()).default([]),
    connectorId:  z.string().nullish(),
    accessMode:   z.string().nullish(),
    customTools:  z.array(z.object({
      type:  z.string().min(1),
      name:  z.string().min(1),
      label: z.string().nullish(),
    })).nullish(),
  })).optional(),
  context: z.object({
    userId: z.string().min(1),
    recordContextId: z.string().nullish(),
    recordContextType: z.string().nullish(),
  }),
  debugMode: z.boolean().optional(),
});

chatRouter.post('/api/chat/turn', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const parsed = turnSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }

  try {
    // Use the per-org tokens captured during Synapse Setup, NOT the bootstrap
    // Client Credentials connection (which subscribers may not have enabled).
    const conn = await getOrgConnection(orgId);
    // AgentCache serves the AgentDefinition + nodes from RAM for up to 60s,
    // eliminating 2 SOQL calls per chat turn.
    const agent = await AgentCache.load(orgId, parsed.data.agentApiName, conn);
    if (!agent) {
      res.status(404).json({ error: 'agent_not_found' });
      return;
    }
    if (agent.status !== 'Active') {
      res.status(409).json({ error: 'agent_not_active', status: agent.status });
      return;
    }

    const result = await runChatTurn({
      agent,
      sessionId: parsed.data.sessionId,
      history:   parsed.data.history,
      newUserMessage: parsed.data.newUserMessage,
      attachments:    parsed.data.attachments,
      engineOverride: parsed.data.engineOverride,
      connectors:     parsed.data.connectors,
      debugMode:      parsed.data.debugMode,
      context: {
        orgId,
        userId: parsed.data.context.userId,
        recordContextId:   parsed.data.context.recordContextId ?? null,
        recordContextType: parsed.data.context.recordContextType ?? null,
      },
    });
    res.json(result);
  } catch (err) {
    logger.error({ err, orgId, agentApiName: parsed.data.agentApiName }, 'chat_turn_failed');
    // Belt-and-braces — also write to stderr so it can't be missed in the terminal
    // eslint-disable-next-line no-console
    console.error('\n=== CHAT TURN FAILED ===\n', err, '\n=========================\n');
    res.status(500).json({ error: 'chat_turn_failed', message: (err as Error).message });
  }
});

// /api/chat/approve-tool removed — Managed MCP providers execute tools
// directly, so there is no approval pause to resume from.

/**
 * Builder Copilot — sessionAuth. Proposes graph mutations for an EXISTING
 * agent from a natural-language request; never writes anything itself. See
 * server/src/agent-generator/copilot.ts for the actual logic.
 */
import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../auth/session';
import { logger } from '../logger';
import { proposeCopilotChanges } from '../agent-generator/copilot';

export const copilotRouter = Router();

const requestSchema = z.object({
  mode: z.enum(['trigger', 'chat']),
  agent: z.object({
    name: z.string(),
    department: z.string(),
    description: z.string(),
  }),
  nodes: z.array(z.object({
    id: z.string(),
    label: z.string(),
    nodeType: z.string(),
    nodeSubType: z.string(),
    config: z.record(z.string(), z.unknown()),
  })),
  connections: z.array(z.object({
    id: z.string(),
    fromNodeId: z.string(),
    fromPort: z.string(),
    toNodeId: z.string(),
    toPort: z.string(),
  })),
  message: z.string().min(1),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string(),
  })).default([]),
  engineOverride: z.object({
    engineType:   z.string().nullish(),
    apiKey:       z.string().nullish(),
    endpoint:     z.string().nullish(),
    defaultModel: z.string().nullish(),
    connectionId: z.string().nullish(),
  }).optional(),
});

copilotRouter.post('/api/agent/copilot', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    return;
  }
  const { engineOverride, ...copilotReq } = parsed.data;
  try {
    const result = await proposeCopilotChanges(copilotReq, engineOverride);
    res.json(result);
  } catch (err) {
    logger.error({ err, orgId }, 'agent_copilot_failed');
    res.status(502).json({ error: 'copilot_failed', message: (err as Error).message });
  }
});

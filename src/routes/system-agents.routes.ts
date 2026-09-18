/**
 * /api/system-agents — write a platform-shipped agent definition into the
 * org's own agent records (see platform/system-agents.ts). Session-guarded:
 * Apex calls it from Setup, and the Home page's first load calls it when
 * the copilot is missing or outdated.
 */
import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../auth/session';
import { logger } from '../logger';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { syncSystemAgent } from '../platform/system-agents';
import { SYSTEM_AGENTS } from '../platform/agents/registry';

export const systemAgentsRouter = Router();

systemAgentsRouter.get('/api/system-agents', sessionAuth, (_req, res) => {
  res.json({ agents: Object.values(SYSTEM_AGENTS).map(s => ({ apiName: s.apiName, name: s.name, version: s.version, managed: s.managed !== false })) });
});

const syncSchema = z.object({ apiName: z.string().min(1).max(120) });

systemAgentsRouter.post('/api/system-agents/sync', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const parsed = syncSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const spec = SYSTEM_AGENTS[parsed.data.apiName];
  if (!spec) {
    res.status(404).json({ error: 'unknown_system_agent', known: Object.keys(SYSTEM_AGENTS) });
    return;
  }
  try {
    const conn = await getOrgConnection(orgId);
    const result = await syncSystemAgent(conn, orgId, spec);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ orgId, apiName: spec.apiName, err: message }, 'system_agent_sync_failed');
    res.status(500).json({ error: 'system_agent_sync_failed', message });
  }
});

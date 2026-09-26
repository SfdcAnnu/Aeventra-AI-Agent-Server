/**
 * /api/mobile — a self-contained surface for the sideloaded demo APK.
 *
 * A phone app outside Salesforce cannot mint the Apex WebSocket ticket or
 * hold a Salesforce session, so this gives it the two things it needs over
 * plain REST: list the org's agents, and take a chat turn — authenticated
 * by ONE shared demo bearer that maps to one org (MOBILE_DEMO_TOKEN /
 * MOBILE_DEMO_ORG_ID). It is a mock-demo door, off unless both are set.
 *
 * Connectors are derived server-side (same as the WebSocket gateway), so
 * the app sends only an agent and a message. CORS is wide open here because
 * the door is the token, not the origin — a Capacitor WebView's origin is
 * localhost, never a Salesforce domain.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../logger';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { AgentCache } from '../chat/agent-cache';
import { connectorsForAgent } from '../salesforce/agent-connectors';
import { runChatTurn } from '../lc/graph-runtime';
import type { Connection } from 'jsforce';
import type { AgentDefinition } from '../types';

export const mobileRouter = Router();

/** Node provider vocabulary → AiEngineConnection__c.EngineType__c. */
const ENGINE_FOR_SUBTYPE: Record<string, string> = { gpt4: 'openai', openai: 'openai', claude: 'claude', anthropic: 'claude', gemini: 'gemini' };

interface EngineConn { Id: string; EngineType__c: string; ApiKey__c?: string; Endpoint__c?: string; DefaultModel__c?: string; IsPreferred__c?: boolean; ValidationStatus__c?: string }

/**
 * The org's AI engine key for this agent's AI node, the way Apex resolves it
 * for desktop turns (the phone bypasses Apex, so the server does it here):
 * prefer a connection whose provider matches the agent's node, then a
 * preferred/validated one, then any active connection with a key.
 */
async function resolveEngineOverride(conn: Connection, agent: AgentDefinition) {
  const aiNode = agent.nodes.find(n => n.nodeType === 'ai');
  const wantEngine = aiNode ? ENGINE_FOR_SUBTYPE[aiNode.nodeSubType] ?? null : null;
  const res = await conn.query<EngineConn>(
    'SELECT Id, EngineType__c, ApiKey__c, Endpoint__c, DefaultModel__c, IsPreferred__c, ValidationStatus__c FROM AiEngineConnection__c WHERE IsActive__c = true',
  );
  const usable = res.records.filter(r => r.ApiKey__c);
  if (usable.length === 0) return null;
  const pick =
    (wantEngine && usable.find(r => r.EngineType__c === wantEngine && r.IsPreferred__c && r.ValidationStatus__c === 'Success')) ||
    (wantEngine && usable.find(r => r.EngineType__c === wantEngine && r.ValidationStatus__c === 'Success')) ||
    (wantEngine && usable.find(r => r.EngineType__c === wantEngine)) ||
    usable.find(r => r.IsPreferred__c && r.ValidationStatus__c === 'Success') ||
    usable[0];
  const nodeModel = (aiNode?.config as { model?: string } | undefined)?.model;
  return {
    engineType: pick.EngineType__c,
    apiKey: pick.ApiKey__c!,
    endpoint: pick.Endpoint__c ?? null,
    defaultModel: nodeModel || pick.DefaultModel__c || null,
    connectionId: pick.Id,
  };
}

// Wide-open CORS: the bearer is the guard, not the origin.
mobileRouter.use('/api/mobile', (req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
});

function mobileAuth(req: Request, res: Response, next: NextFunction): void {
  const token = config.mobile.demoToken;
  const orgId = config.mobile.demoOrgId;
  if (!token || !orgId) {
    res.status(503).json({ error: 'mobile_demo_disabled', message: 'The mobile demo door is not configured on this server.' });
    return;
  }
  const header = req.header('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (given !== token) {
    res.status(401).json({ error: 'invalid_demo_token' });
    return;
  }
  req.orgId = orgId;
  next();
}

/** The agents to show, copilot first. */
mobileRouter.get('/api/mobile/agents', mobileAuth, async (req, res) => {
  const orgId = req.orgId!;
  try {
    const conn = await getOrgConnection(orgId);
    const q = await conn.query<{ Name: string; ApiName__c: string; Department__c?: string; Status__c: string; Description__c?: string }>(
      "SELECT Name, ApiName__c, Department__c, Status__c, Description__c FROM AgentDefinition__c WHERE Status__c = 'Active' ORDER BY Name",
    );
    const agents = q.records.map(r => ({
      name: r.Name,
      apiName: r.ApiName__c,
      department: r.Department__c ?? null,
      description: r.Description__c ?? null,
      copilot: r.ApiName__c === 'archon_copilot',
    }));
    // Copilot first, then the rest alphabetical (already sorted).
    agents.sort((a, b) => Number(b.copilot) - Number(a.copilot));
    res.json({ agents });
  } catch (err) {
    logger.error({ err, orgId }, 'mobile_agents_failed');
    res.status(500).json({ error: 'mobile_agents_failed', message: (err as Error).message });
  }
});

const turnSchema = z.object({
  agentApiName: z.string().min(1).max(120),
  sessionId: z.string().min(1).max(120),
  newUserMessage: z.string().max(20_000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant', 'tool', 'system']),
    content: z.string(),
    toolCallsJson: z.string().nullish(),
    toolResultsJson: z.string().nullish(),
    toolCallId: z.string().nullish(),
  })).default([]),
});

/** One chat turn against a chosen agent. Synchronous, like the desktop REST
 *  path, so it is bounded by the model loop, not a background job. */
mobileRouter.post('/api/mobile/chat', mobileAuth, async (req, res) => {
  const orgId = req.orgId!;
  const parsed = turnSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  try {
    const conn = await getOrgConnection(orgId);
    const agent = await AgentCache.load(orgId, parsed.data.agentApiName, conn);
    if (!agent) { res.status(404).json({ error: 'agent_not_found' }); return; }
    if (agent.status !== 'Active') { res.status(409).json({ error: 'agent_not_active', status: agent.status }); return; }
    const [connectors, engineOverride] = await Promise.all([
      connectorsForAgent(conn, agent, orgId),
      resolveEngineOverride(conn, agent),
    ]);
    if (!engineOverride) {
      res.status(409).json({ error: 'no_ai_engine', message: 'No active AI engine connection with a key in this org. Add one on the AI Models page.' });
      return;
    }
    const result = await runChatTurn({
      agent,
      sessionId: parsed.data.sessionId,
      history: parsed.data.history,
      newUserMessage: parsed.data.newUserMessage,
      connectors,
      engineOverride,
      context: { orgId, userId: 'mobile-demo', recordContextId: null, recordContextType: null },
    });
    res.json({
      status: result.status,
      assistantText: result.assistantText ?? '',
      toolCalls: (result.toolCalls ?? []).map(t => ({ name: t.name, isError: t.isError === true })),
      modelUsed: result.modelUsed ?? null,
    });
  } catch (err) {
    logger.error({ err, orgId, agentApiName: parsed.data.agentApiName }, 'mobile_chat_failed');
    res.status(500).json({ error: 'mobile_chat_failed', message: (err as Error).message });
  }
});

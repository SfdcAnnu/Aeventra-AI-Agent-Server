/**
 * /api/mobile — the surface for the Archon mobile app.
 *
 * Auth is server-brokered OAuth with PKCE (the platform's own pattern): the
 * phone never holds the Salesforce client secret or refresh token. The app
 * opens Salesforce login in the system browser; Salesforce redirects to this
 * server; the server exchanges the code, stores the user's SF tokens on their
 * per-user Connector row, and hands the device only a revocable session token
 * via a custom-scheme deep link. Every turn then runs as that signed-in user.
 *
 * A shared demo token (MOBILE_DEMO_TOKEN → MOBILE_DEMO_ORG_ID) stays as a
 * fallback for quick demos; it maps to the org with a synthetic user.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import type { Connection } from 'jsforce';
import { config } from '../config';
import { logger } from '../logger';
import { pkgConn } from '../salesforce/namespace';
import { prisma } from '../db/client';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { AgentCache } from '../chat/agent-cache';
import { connectorsForAgent } from '../salesforce/agent-connectors';
import { runChatTurn } from '../lc/graph-runtime';
import { ConnectorsRepo } from '../db/connectors.repo';
import { fetchUserInfo } from '../oauth/salesforce';
import type { AgentDefinition } from '../types';

export const mobileRouter = Router();

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PENDING_TTL_MS = 10 * 60 * 1000;           // 10 minutes
const APP_SCHEME = () => (process.env.MOBILE_APP_SCHEME || 'com.archon.demo').replace(/[^a-z0-9.\-_]/gi, '');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const b64url = (b: Buffer) => b.toString('base64url');

// ── CORS: the bearer is the guard, not the origin (Capacitor is localhost) ──
mobileRouter.use('/api/mobile', (req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
});

// ── resolved caller ─────────────────────────────────────────────────
interface Caller { orgId: string; userId: string }
declare global { namespace Express { interface Request { mobile?: Caller } } }

async function mobileAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) { res.status(401).json({ error: 'missing_token' }); return; }

  // 1) A real per-user session (server-brokered OAuth).
  const row = await prisma.mobileSession.findUnique({ where: { id: sha256(token) } }).catch(() => null);
  if (row) {
    if (row.expiresAt.getTime() < Date.now()) {
      await prisma.mobileSession.delete({ where: { id: row.id } }).catch(() => undefined);
      res.status(401).json({ error: 'session_expired' });
      return;
    }
    prisma.mobileSession.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
    req.mobile = { orgId: row.orgId, userId: row.userId };
    next();
    return;
  }

  // 2) The shared demo token (fallback).
  if (config.mobile.demoToken && config.mobile.demoOrgId && token === config.mobile.demoToken) {
    req.mobile = { orgId: config.mobile.demoOrgId, userId: 'mobile-demo' };
    next();
    return;
  }
  res.status(401).json({ error: 'invalid_token' });
}

// ════════════════════════════════════════════════════════════════════
//  OAuth: log in with Salesforce (server-brokered, PKCE)
// ════════════════════════════════════════════════════════════════════

/** Normalise the chosen org into a Salesforce login host. */
function loginHostFor(env: string, myDomain?: string | null): string {
  const md = (myDomain || '').trim();
  if (md) {
    if (/^https?:\/\//i.test(md)) return md.replace(/\/+$/, '');
    const sub = md.replace(/\.my\.salesforce\.com.*$/i, '').replace(/[^a-z0-9-]/gi, '');
    if (sub) return `https://${sub}.my.salesforce.com`;
  }
  return env === 'sandbox' ? 'https://test.salesforce.com' : 'https://login.salesforce.com';
}

const startSchema = z.object({
  env: z.enum(['prod', 'sandbox']).default('prod'),
  myDomain: z.string().max(200).optional(),
});

mobileRouter.post('/api/mobile/oauth/start', async (req, res) => {
  if (!config.salesforce.mcpClientId || !config.salesforce.mcpClientSecret) {
    res.status(503).json({ error: 'oauth_not_configured', message: 'Salesforce login is not configured on this server.' });
    return;
  }
  const parsed = startSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'invalid_body' }); return; }

  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const loginHost = loginHostFor(parsed.data.env, parsed.data.myDomain);
  await prisma.mobileAuthPending.create({
    data: { state, verifier, loginHost, expiresAt: new Date(Date.now() + PENDING_TTL_MS) },
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.salesforce.mcpClientId,
    redirect_uri: `${config.serverPublicUrl.replace(/\/+$/, '')}/api/mobile/oauth/callback`,
    scope: 'api refresh_token openid',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'login',
  });
  res.json({ authorizeUrl: `${loginHost}/services/oauth2/authorize?${params.toString()}` });
});

/** Redirect target for Salesforce — no bearer (the browser carries none). */
mobileRouter.get('/api/mobile/oauth/callback', async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const scheme = APP_SCHEME();
  const bounce = (params: Record<string, string>) => {
    const u = new URLSearchParams(params).toString();
    res.redirect(`${scheme}://auth?${u}`);
  };
  const pending = q.state ? await prisma.mobileAuthPending.findUnique({ where: { state: q.state } }).catch(() => null) : null;
  if (pending) await prisma.mobileAuthPending.delete({ where: { state: pending.state } }).catch(() => undefined);
  if (!pending || pending.expiresAt.getTime() < Date.now()) { bounce({ error: 'expired' }); return; }
  if (q.error || !q.code) { bounce({ error: (q.error_description || q.error || 'denied').slice(0, 80) }); return; }

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: q.code,
      client_id: config.salesforce.mcpClientId,
      client_secret: config.salesforce.mcpClientSecret,
      redirect_uri: `${config.serverPublicUrl.replace(/\/+$/, '')}/api/mobile/oauth/callback`,
      code_verifier: pending.verifier,
    });
    const tokRes = await fetch(`${pending.loginHost}/services/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
    });
    const tok = (await tokRes.json()) as { access_token?: string; refresh_token?: string; instance_url?: string; error_description?: string; error?: string };
    if (!tokRes.ok || !tok.access_token || !tok.instance_url) {
      logger.warn({ err: tok.error_description ?? tok.error }, 'mobile_oauth_token_failed');
      bounce({ error: 'token_exchange_failed' });
      return;
    }
    const who = await fetchUserInfo(tok.instance_url, tok.access_token);
    if (!who.user_id || !who.organization_id) { bounce({ error: 'identity_failed' }); return; }

    // Store the user's SF tokens on their per-user Connector row, so every
    // per-user token lookup (chat, MCP) finds them — the same mechanism as
    // "Connect my Salesforce" on desktop.
    const connector = await ConnectorsRepo.upsertPending({
      orgId: who.organization_id, providerKey: 'salesforce_mcp',
      displayName: who.email || 'Salesforce (mobile)', authType: 'OAuth2', configuredBy: who.user_id,
    });
    await ConnectorsRepo.markConnected(connector.id, {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      instanceUrl: tok.instance_url,
      accountEmail: who.email ?? null,
      externalAccountId: who.user_id,
      scopes: 'api refresh_token openid',
    });

    // Mint the device session (only its hash is stored).
    const sessionToken = b64url(randomBytes(32));
    await prisma.mobileSession.create({
      data: { id: sha256(sessionToken), orgId: who.organization_id, userId: who.user_id, username: who.email ?? null, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
    });
    logger.info({ orgId: who.organization_id, userId: who.user_id }, 'mobile_oauth_connected');
    bounce({ session: sessionToken });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'mobile_oauth_callback_failed');
    bounce({ error: 'server_error' });
  }
});

mobileRouter.post('/api/mobile/logout', mobileAuth, async (req, res) => {
  const header = req.header('authorization') ?? '';
  const token = header.slice(7).trim();
  await prisma.mobileSession.delete({ where: { id: sha256(token) } }).catch(() => undefined);
  res.json({ ok: true });
});

/** Who am I — lets the app show the signed-in user and validate its session. */
mobileRouter.get('/api/mobile/me', mobileAuth, async (req, res) => {
  const { orgId, userId } = req.mobile!;
  const demo = userId === 'mobile-demo';
  let username: string | null = null;
  if (!demo) {
    const row = await prisma.mobileSession.findFirst({ where: { orgId, userId }, orderBy: { lastSeenAt: 'desc' } }).catch(() => null);
    username = row?.username ?? null;
  }
  res.json({ orgId, userId, username, demo });
});

// ════════════════════════════════════════════════════════════════════
//  Agents + chat (run as the resolved caller)
// ════════════════════════════════════════════════════════════════════

const ENGINE_FOR_SUBTYPE: Record<string, string> = { gpt4: 'openai', openai: 'openai', claude: 'claude', anthropic: 'claude', gemini: 'gemini' };
interface EngineConn { Id: string; EngineType__c: string; ApiKey__c?: string; Endpoint__c?: string; DefaultModel__c?: string; IsPreferred__c?: boolean; ValidationStatus__c?: string }

async function resolveEngineOverride(conn: Connection, agent: AgentDefinition) {
  const aiNode = agent.nodes.find(n => n.nodeType === 'ai');
  const wantEngine = aiNode ? ENGINE_FOR_SUBTYPE[aiNode.nodeSubType] ?? null : null;
  const res = await pkgConn(conn).query<EngineConn>(
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
  return { engineType: pick.EngineType__c, apiKey: pick.ApiKey__c!, endpoint: pick.Endpoint__c ?? null, defaultModel: nodeModel || pick.DefaultModel__c || null, connectionId: pick.Id };
}

mobileRouter.get('/api/mobile/agents', mobileAuth, async (req, res) => {
  const { orgId } = req.mobile!;
  try {
    const conn = await getOrgConnection(orgId);
    const q = await pkgConn(conn).query<{ Name: string; ApiName__c: string; Department__c?: string; Status__c: string; Description__c?: string }>(
      "SELECT Name, ApiName__c, Department__c, Status__c, Description__c FROM AgentDefinition__c WHERE Status__c = 'Active' ORDER BY Name",
    );
    const agents = q.records.map(r => ({
      name: r.Name, apiName: r.ApiName__c, department: r.Department__c ?? null,
      description: r.Description__c ?? null, copilot: r.ApiName__c === 'archon_copilot',
    }));
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

mobileRouter.post('/api/mobile/chat', mobileAuth, async (req, res) => {
  const { orgId, userId } = req.mobile!;
  const parsed = turnSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() }); return; }
  try {
    const conn = await getOrgConnection(orgId);
    const agent = await AgentCache.load(orgId, parsed.data.agentApiName, conn);
    if (!agent) { res.status(404).json({ error: 'agent_not_found' }); return; }
    if (agent.status !== 'Active') { res.status(409).json({ error: 'agent_not_active', status: agent.status }); return; }
    const [connectors, engineOverride] = await Promise.all([
      connectorsForAgent(conn, agent, orgId),
      resolveEngineOverride(conn, agent),
    ]);
    if (!engineOverride) { res.status(409).json({ error: 'no_ai_engine', message: 'No active AI engine connection with a key in this org.' }); return; }
    const result = await runChatTurn({
      agent,
      sessionId: parsed.data.sessionId,
      history: parsed.data.history,
      newUserMessage: parsed.data.newUserMessage,
      connectors,
      engineOverride,
      context: { orgId, userId, recordContextId: null, recordContextType: null },
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

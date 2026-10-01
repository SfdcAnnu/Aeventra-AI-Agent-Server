/**
 * Identity routes — sessionAuth, org-scoped.
 *
 *   GET/PUT  /api/connectors/policy            the org-wide identity policy
 *   GET      /api/connectors/detail            one provider: org, group and user connections, override
 *   GET      /api/connectors/principals        every connection row of a provider (no tokens) + reminders
 *   POST     /api/connectors/requirements      what one person must connect for one agent (the chat gate)
 *   GET      /api/connectors/groups            Permission Sets / Public Groups / Departments to bind a group to
 *   GET/PUT/DELETE /api/connectors/server      an admin's MCP server override for a provider
 *   POST     /api/connectors/server/test       list a server's tools with the org identity
 *   POST/GET /api/connectors/reminders         record a reminder sent to a person / list them
 */
import { Router } from 'express';
import { z } from 'zod';
import { logger } from '../logger';
import { sessionAuth } from '../auth/session';
import { pkgConn } from '../salesforce/namespace';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { InstallsRepo } from '../db/installs.repo';
import { ConnectorsRepo } from '../db/connectors.repo';
import { ConnectorsCache } from '../db/connectors-cache';
import { OrgIdentityPolicyRepo, RemindersRepo, ServerOverrideRepo } from '../db/identity.repo';
import { AgentCache } from '../chat/agent-cache';
import { listToolsCached, McpRateLimited } from '../mcp/tool-list-cache';
import { listGroups, membershipFor, type GroupKeyType } from '../identity/membership';
import { forgetGroupConnections, resolveIdentity } from '../identity/resolver';
import { identityInputFromConfig, policyFor, type IdentityPolicy } from '../identity/policy';
import { sfJwtConfigured } from '../oauth/salesforce-jwt';
import { SALESFORCE_TOKEN_PROVIDERS } from '../chat/connector-scope';
import '../chat/adapters/shared';   // registers the token freshener
import type { Connector } from '@prisma/client';

export const identityRouter = Router();

/** A connection as the pages see it — never its tokens. */
function summarise(r: Connector) {
  return {
    id: r.id, providerKey: r.providerKey, status: r.status,
    principalType: r.principalType, subjectType: r.subjectType, subjectKey: r.subjectKey, subjectLabel: r.subjectLabel,
    accountEmail: r.accountEmail, configuredBy: r.configuredBy,
    lastConnectedAt: r.lastConnectedAt, lastErrorMessage: r.lastErrorMessage,
    tokenExpiresAt: r.tokenExpiresAt, hasRefreshToken: !!r.refreshToken,
  };
}

// ── policy ─────────────────────────────────────────────────────────
identityRouter.get('/api/connectors/policy', sessionAuth, async (req, res) => {
  const policy = await OrgIdentityPolicyRepo.get(req.orgId!);
  res.json({ policy, sfJwt: { configured: sfJwtConfigured(), enabled: policy.sfJwtEnabled } });
});

const policySchema = z.object({
  defaultRunAs: z.enum(['user', 'group', 'org']).optional(),
  defaultFallback: z.enum(['none', 'org']).optional(),
  blockOrgFallbackForChat: z.boolean().optional(),
  groupKeyType: z.enum(['permissionSet', 'publicGroup', 'department']).optional(),
  sfJwtEnabled: z.boolean().optional(),
  allowedDomains: z.array(z.string().max(120)).max(20).optional(),
  reminderEveryDays: z.number().int().min(1).max(30).optional(),
  reminderMax: z.number().int().min(1).max(20).optional(),
});

identityRouter.put('/api/connectors/policy', sessionAuth, async (req, res) => {
  const parsed = policySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() }); return; }
  if (parsed.data.sfJwtEnabled && !sfJwtConfigured()) {
    res.status(400).json({ error: 'sf_jwt_not_configured', message: 'Set SF_JWT_CLIENT_ID and SF_JWT_PRIVATE_KEY on the server before turning this on.' });
    return;
  }
  const policy = await OrgIdentityPolicyRepo.upsert(req.orgId!, parsed.data);
  logger.info({ orgId: req.orgId, policy }, 'identity_policy_saved');
  res.json({ policy, sfJwt: { configured: sfJwtConfigured(), enabled: policy.sfJwtEnabled } });
});

// ── one provider's connections ─────────────────────────────────────
identityRouter.get('/api/connectors/detail', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const providerKey = String(req.query.providerKey ?? '');
  if (!providerKey) { res.status(400).json({ error: 'missing_provider' }); return; }
  const rows = await ConnectorsRepo.listPrincipals(orgId, providerKey);
  const org = rows.filter(r => r.principalType === 'org').sort((a, b) => (b.lastConnectedAt?.getTime() ?? 0) - (a.lastConnectedAt?.getTime() ?? 0))[0] ?? null;
  const groups = rows.filter(r => r.principalType === 'group');
  const users = rows.filter(r => r.principalType === 'user');
  const now = Date.now();
  const expired = users.filter(u => u.status === 'Connected' && u.tokenExpiresAt && u.tokenExpiresAt.getTime() < now && !u.refreshToken).length;
  const override = await ServerOverrideRepo.get(orgId, providerKey);
  const policy = await OrgIdentityPolicyRepo.get(orgId);
  res.json({
    providerKey,
    org: org ? summarise(org) : null,
    groups: groups.map(summarise),
    users: {
      connected: users.filter(u => u.status === 'Connected').length - expired,
      pending: users.filter(u => u.status === 'Pending').length,
      error: users.filter(u => u.status === 'Error').length,
      expired,
      total: users.length,
    },
    override: override ? { mcpServerUrl: override.mcpServerUrl, authStyle: override.authStyle, hasApiKey: !!override.apiKey, updatedAt: override.updatedAt } : null,
    policy: { blockOrgFallbackForChat: policy.blockOrgFallbackForChat, groupKeyType: policy.groupKeyType },
    salesforce: SALESFORCE_TOKEN_PROVIDERS.has(providerKey) ? { jwtConfigured: sfJwtConfigured(), jwtEnabled: policy.sfJwtEnabled } : null,
  });
});

identityRouter.get('/api/connectors/principals', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const providerKey = String(req.query.providerKey ?? '');
  if (!providerKey) { res.status(400).json({ error: 'missing_provider' }); return; }
  const [rows, reminders] = await Promise.all([ConnectorsRepo.listPrincipals(orgId, providerKey), RemindersRepo.list(orgId, providerKey)]);
  res.json({ connections: rows.map(summarise), reminders });
});

/** One line per provider for the directory's chips: who has connected. */
identityRouter.get('/api/connectors/identity-summary', sessionAuth, async (req, res) => {
  const rows = await ConnectorsRepo.listForOrg(req.orgId!);
  const now = Date.now();
  const byProvider: Record<string, { org: boolean; groups: number; users: { connected: number; expired: number; total: number } }> = {};
  for (const r of rows) {
    const s = (byProvider[r.providerKey] ??= { org: false, groups: 0, users: { connected: 0, expired: 0, total: 0 } });
    if (r.principalType === 'org') s.org = s.org || r.status === 'Connected';
    else if (r.principalType === 'group') { if (r.status === 'Connected') s.groups++; }
    else {
      s.users.total++;
      if (r.status === 'Connected') {
        if (r.tokenExpiresAt && r.tokenExpiresAt.getTime() < now && !r.refreshToken) s.users.expired++;
        else s.users.connected++;
      }
    }
  }
  res.json({ providers: byProvider });
});

// ── what a builder may pin on a node ───────────────────────────────
const usableSchema = z.object({ userId: z.string().min(1), providerKey: z.string().min(1) });

/** The connections THIS person can choose for a provider on the canvas:
 *  their own, their groups', and the org's — plus the groups they belong
 *  to, for connecting a new team account. */
identityRouter.post('/api/connectors/usable', sessionAuth, async (req, res) => {
  const parsed = usableSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() }); return; }
  const orgId = req.orgId!;
  const { userId, providerKey } = parsed.data;
  const rows = await ConnectorsRepo.listPrincipals(orgId, providerKey);
  let groups: Array<{ type: string; key: string; label: string }> = [];
  try {
    const conn = await getOrgConnection(orgId);
    groups = (await membershipFor(conn, orgId, userId)).groups;
  } catch (err) {
    logger.warn({ err, orgId, userId }, 'identity_usable_membership_failed');
  }
  const inGroup = (r: Connector) => groups.some(g => g.type === r.subjectType && g.key === r.subjectKey);
  const live = (r: Connector) => r.status !== 'Disconnected';
  res.json({
    mine: rows.filter(r => r.principalType === 'user' && r.subjectKey === userId && live(r)).map(summarise),
    team: rows.filter(r => r.principalType === 'group' && inGroup(r) && live(r)).map(summarise),
    org: rows.filter(r => r.principalType === 'org' && r.status === 'Connected').sort((a, b) => (b.lastConnectedAt?.getTime() ?? 0) - (a.lastConnectedAt?.getTime() ?? 0)).map(summarise)[0] ?? null,
    groups,
  });
});

// ── a person's own connections (self-service) ──────────────────────
const mineSchema = z.object({ userId: z.string().min(1) });

identityRouter.post('/api/connectors/mine', sessionAuth, async (req, res) => {
  const parsed = mineSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() }); return; }
  const orgId = req.orgId!;
  const rows = (await ConnectorsRepo.listForOrg(orgId)).filter(r => r.principalType === 'user' && r.subjectKey === parsed.data.userId);
  const reminders = (await RemindersRepo.list(orgId)).filter(r => r.userId === parsed.data.userId);
  res.json({ connections: rows.map(summarise), reminders });
});

const mineDisconnectSchema = z.object({ userId: z.string().min(1), connectorId: z.string().min(1) });

identityRouter.post('/api/connectors/mine/disconnect', sessionAuth, async (req, res) => {
  const parsed = mineDisconnectSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() }); return; }
  const orgId = req.orgId!;
  const row = await ConnectorsRepo.getById(orgId, parsed.data.connectorId);
  // Only the person's own row: a chat user can never disconnect anyone else.
  if (!row || row.principalType !== 'user' || row.subjectKey !== parsed.data.userId) { res.status(404).json({ error: 'not_yours' }); return; }
  await ConnectorsRepo.disconnect(orgId, row.id);
  forgetIdentityCaches(orgId);
  res.json({ ok: true });
});

// ── the chat gate: what one person must connect for one agent ──────
const requirementsSchema = z.object({ agentApiName: z.string().min(1), userId: z.string().min(1) });

export type RequirementStatus = 'connected' | 'automatic' | 'needed' | 'expired' | 'wrong_account' | 'needs_group' | 'org' | 'pinned';

identityRouter.post('/api/connectors/requirements', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const parsed = requirementsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() }); return; }
  const { agentApiName, userId } = parsed.data;
  try {
    const conn = await getOrgConnection(orgId);
    const agent = await AgentCache.load(orgId, agentApiName, conn);
    if (!agent) { res.status(404).json({ error: 'agent_not_found' }); return; }
    const install = await InstallsRepo.findByOrgId(orgId);
    const orgPolicy = await OrgIdentityPolicyRepo.get(orgId);
    const names = new Map<string, string>();
    try {
      const cat = await pkgConn(conn).query<{ DeveloperName: string; DisplayName__c?: string }>('SELECT DeveloperName, DisplayName__c FROM ConnectorCatalog__mdt');
      for (const r of cat.records) names.set(r.DeveloperName, r.DisplayName__c ?? r.DeveloperName);
    } catch { /* names are a nicety */ }

    const seen = new Set<string>();
    const requirements: Array<{ provider: string; displayName: string; runAs: string; required: boolean; status: RequirementStatus; accountEmail: string | null; message: string | null; connectorId: string | null }> = [];
    for (const n of agent.nodes) {
      if (n.nodeType !== 'catalog' || !n.isEnabled) continue;
      const cfg = (n.config ?? {}) as Record<string, unknown>;
      const provider = typeof cfg.provider === 'string' ? cfg.provider : '';
      if (!provider || seen.has(provider)) continue;
      seen.add(provider);
      const policy: IdentityPolicy = policyFor(identityInputFromConfig(cfg), SALESFORCE_TOKEN_PROVIDERS.has(provider) ? agent.accessMode : null, orgPolicy, 'chat');
      const displayName = names.get(provider) ?? provider;
      if (policy.runAs === 'org') {
        requirements.push({ provider, displayName, runAs: 'org', required: false, status: 'org', accountEmail: null, message: null, connectorId: null });
        continue;
      }
      const r = await resolveIdentity({ orgId, userId, provider, policy, kind: 'chat', explicitConnectorId: (cfg.connectorId as string) || null, sfAccessToken: install?.sfAccessToken ?? null, orgPolicy, agentApiName });
      if (policy.runAs === 'connection') {
        // The node pinned a connection: nothing to ask of the person — but
        // a broken one stops the agent, and only its owner or an admin can fix it.
        if (r.ok) requirements.push({ provider, displayName, runAs: 'connection', required: false, status: 'pinned', accountEmail: r.principal.accountEmail ?? r.principal.subjectLabel ?? null, message: null, connectorId: r.principal.connectorId });
        else requirements.push({ provider, displayName, runAs: 'connection', required: true, status: 'needs_group', accountEmail: null, message: r.message, connectorId: null });
        continue;
      }
      if (r.ok) {
        requirements.push({ provider, displayName, runAs: policy.runAs, required: policy.required, status: r.principal.via === 'jwt' || r.principal.via === 'setup' ? 'automatic' : 'connected', accountEmail: r.principal.accountEmail ?? r.principal.subjectLabel ?? null, message: null, connectorId: r.principal.connectorId });
      } else {
        const status: RequirementStatus = r.reason === 'expired' ? 'expired' : r.reason === 'wrong_account' ? 'wrong_account' : r.reason === 'needs_group_connection' ? 'needs_group' : 'needed';
        requirements.push({ provider, displayName, runAs: policy.runAs, required: policy.required, status, accountEmail: null, message: r.message, connectorId: null });
      }
    }
    const blocking = requirements.filter(r => r.required && r.status !== 'connected' && r.status !== 'automatic' && r.status !== 'org' && r.status !== 'pinned');
    res.json({ requirements, runsAsUser: requirements.some(r => r.runAs === 'user'), ready: blocking.length === 0, blocking: blocking.map(b => b.provider) });
  } catch (err) {
    logger.error({ err, orgId, agentApiName }, 'identity_requirements_failed');
    res.status(500).json({ error: 'requirements_failed', message: (err as Error).message });
  }
});

// ── groups to bind a group connection to ───────────────────────────
identityRouter.get('/api/connectors/groups', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const type = String(req.query.type ?? '') as GroupKeyType;
  if (!['permissionSet', 'publicGroup', 'department'].includes(type)) { res.status(400).json({ error: 'invalid_type' }); return; }
  try {
    const conn = await getOrgConnection(orgId);
    res.json({ groups: await listGroups(conn, type) });
  } catch (err) {
    res.status(502).json({ error: 'groups_failed', message: (err as Error).message });
  }
});

// ── MCP server override ────────────────────────────────────────────
identityRouter.get('/api/connectors/server', sessionAuth, async (req, res) => {
  const providerKey = String(req.query.providerKey ?? '');
  if (!providerKey) { res.status(400).json({ error: 'missing_provider' }); return; }
  const o = await ServerOverrideRepo.get(req.orgId!, providerKey);
  res.json({ override: o ? { mcpServerUrl: o.mcpServerUrl, authStyle: o.authStyle, hasApiKey: !!o.apiKey, updatedAt: o.updatedAt, updatedBy: o.updatedBy } : null });
});

const serverSchema = z.object({
  providerKey: z.string().min(1),
  mcpServerUrl: z.string().url(),
  authStyle: z.enum(['provider-token', 'mcp-oauth', 'api-key', 'salesforce-session', 'none']).optional(),
  apiKey: z.string().max(4000).nullish(),
  userId: z.string().nullish(),
});

identityRouter.put('/api/connectors/server', sessionAuth, async (req, res) => {
  const parsed = serverSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() }); return; }
  const { providerKey, mcpServerUrl, authStyle, apiKey, userId } = parsed.data;
  const o = await ServerOverrideRepo.upsert(req.orgId!, providerKey, { mcpServerUrl, authStyle, apiKey: apiKey === undefined ? undefined : apiKey, updatedBy: userId ?? null });
  logger.info({ orgId: req.orgId, providerKey, mcpServerUrl, authStyle: o.authStyle }, 'connector_server_override_saved');
  res.json({ override: { mcpServerUrl: o.mcpServerUrl, authStyle: o.authStyle, hasApiKey: !!o.apiKey, updatedAt: o.updatedAt } });
});

identityRouter.delete('/api/connectors/server', sessionAuth, async (req, res) => {
  const providerKey = String(req.query.providerKey ?? '');
  if (!providerKey) { res.status(400).json({ error: 'missing_provider' }); return; }
  await ServerOverrideRepo.remove(req.orgId!, providerKey);
  res.json({ ok: true });
});

const testSchema = z.object({ providerKey: z.string().min(1), mcpServerUrl: z.string().url(), authStyle: z.string().optional(), apiKey: z.string().nullish(), userId: z.string().nullish() });

identityRouter.post('/api/connectors/server/test', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const parsed = testSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() }); return; }
  const { providerKey, mcpServerUrl, authStyle, apiKey } = parsed.data;
  const t0 = Date.now();
  try {
    let token = apiKey ?? '';
    if (authStyle !== 'api-key' && authStyle !== 'none') {
      const install = await InstallsRepo.findByOrgId(orgId);
      const orgPolicy = await OrgIdentityPolicyRepo.get(orgId);
      const r = await resolveIdentity({
        orgId, userId: parsed.data.userId ?? '', provider: providerKey,
        policy: { runAs: 'org', fallback: 'none', required: false, automationRunAs: 'org' }, kind: 'chat',
        sfAccessToken: install?.sfAccessToken ?? null, orgPolicy,
      });
      if (!r.ok) { res.status(409).json({ error: 'not_connected', message: `No org connection for ${providerKey} to test with: ${r.message}` }); return; }
      token = r.token;
    }
    const tools = await listToolsCached({ remoteUrl: mcpServerUrl, accessToken: token, force: true });
    res.json({ ok: true, ms: Date.now() - t0, count: tools.length, tools: tools.map(t => t.name) });
  } catch (err) {
    if (err instanceof McpRateLimited) { res.status(429).json({ error: 'tool_server_busy', message: err.message }); return; }
    res.status(502).json({ ok: false, ms: Date.now() - t0, error: 'server_test_failed', message: (err as Error).message });
  }
});

// ── reminders ──────────────────────────────────────────────────────
const remindSchema = z.object({ providerKey: z.string().min(1), userIds: z.array(z.string().min(1)).min(1).max(200), agentApiName: z.string().nullish(), channel: z.string().max(40).optional() });

identityRouter.post('/api/connectors/reminders', sessionAuth, async (req, res) => {
  const parsed = remindSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() }); return; }
  const { providerKey, userIds, agentApiName, channel } = parsed.data;
  const rows = [];
  for (const userId of userIds) rows.push(await RemindersRepo.record(req.orgId!, providerKey, userId, agentApiName ?? null, channel ?? 'email'));
  res.json({ reminders: rows });
});

identityRouter.get('/api/connectors/reminders', sessionAuth, async (req, res) => {
  const providerKey = req.query.providerKey ? String(req.query.providerKey) : undefined;
  res.json({ reminders: await RemindersRepo.list(req.orgId!, providerKey) });
});

/** Connect / disconnect elsewhere must drop what the resolver holds. */
export function forgetIdentityCaches(orgId: string): void {
  ConnectorsCache.invalidateOrg(orgId);
  forgetGroupConnections(orgId);
}

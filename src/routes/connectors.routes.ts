/**
 * Connectors API — sessionAuth, org-scoped.
 *
 * The Salesforce MCP tile is no longer a separate OAuth flow — it's derived
 * from OrgInstall. The same SF tokens captured during app Setup are reused
 * as the Bearer when the server hits the standalone Salesforce MCP server.
 *
 * Future connectors (Slack, Drive, etc.) would add real Connector rows; for
 * this phase we ship one virtual connector (`salesforce_mcp`) sourced from
 * OrgInstall.
 */
import { Router } from 'express';
import crypto from 'crypto';
import { logger } from '../logger';
import { pkgConn } from '../salesforce/namespace';
import { config } from '../config';
import { sessionAuth } from '../auth/session';
import { InstallsRepo } from '../db/installs.repo';
import { refreshOrgInstall } from '../salesforce/per-org-connection';
import { ConnectorsRepo, PendingOAuthRepo } from '../db/connectors.repo';
import { ConnectorsCache } from '../db/connectors-cache';
import { mcpListTools } from '../mcp/clients/streamable-http-client';
import { listToolsCached, McpRateLimited } from '../mcp/tool-list-cache';
import { buildAuthorizeUrl, createPkcePair, exchangeCode, fetchUserInfo, parseUserIdFromIdUrl, brokerRedirectUri as sfBrokerRedirectUri } from '../oauth/salesforce';
import {
  googleConfigured,
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  GOOGLE_SCOPES,
} from '../oauth/google';
import {
  microsoftConfigured,
  buildMicrosoftAuthorizeUrl,
  exchangeMicrosoftCode,
  fetchMicrosoftUserInfo,
} from '../oauth/microsoft';
import type { OrgInstall } from '@prisma/client';
import { forgetGroupConnections } from '../identity/resolver';
import { accountMatchesDomains } from '../identity/policy';
import { OrgIdentityPolicyRepo } from '../db/identity.repo';
import { SALESFORCE_TOKEN_PROVIDERS } from '../chat/connector-scope';

export const connectorsRouter = Router();

// ── OAuth broker — provider registry ─────────────────────────────────
// Each provider knows how to build its authorize URL and finish the
// exchange. Adding Outlook later = one more entry here.

interface OAuthStartCtx {
  /** The org's My Domain (from OrgInstall) — Salesforce authorize must run
   *  there; orgfarm dev orgs error out on generic login.salesforce.com. */
  sfMyDomainUrl?: string | null;
  /** S256 PKCE challenge, for a provider with `pkce: true`. */
  codeChallenge?: string | null;
}

interface OAuthProvider {
  configured: () => boolean;
  notConfiguredHint: string;
  authorizeUrl: (state: string, ctx: OAuthStartCtx) => string;
  /** Sends a PKCE challenge; the verifier comes back to `finish`. */
  pkce?: boolean;
  finish: (code: string, codeVerifier?: string | null) => Promise<{
    accessToken: string;
    refreshToken?: string | null;
    tokenExpiresAt?: Date | null;
    scopes?: string | null;
    instanceUrl?: string | null;
    accountEmail?: string | null;
    externalAccountId?: string | null;
  }>;
}

const OAUTH_PROVIDERS: Record<string, OAuthProvider> = {
  // Per-user Salesforce connection — chat tool calls run with THIS user's
  // record access instead of the org-level Archon Setup tokens. Runtime
  // prefers the chatting user's personal connection when one exists.
  salesforce_mcp: {
    configured: () => !!(config.salesforce.mcpClientId && config.salesforce.mcpClientSecret),
    notConfiguredHint: 'Salesforce OAuth is not configured — set SF_MCP_CLIENT_ID and SF_MCP_CLIENT_SECRET in server/.env.',
    // Scopes/prompt/host must MIRROR the setup flow exactly — that flow is
    // proven against the same External Client App. Requesting a scope the
    // ECA doesn't have (e.g. chatter_api) fails at the approval step with
    // OAUTH_APPROVAL_ERROR_GENERIC.
    pkce: true,
    authorizeUrl: (state, ctx) => buildAuthorizeUrl(state, ['refresh_token', 'api', 'id'], sfBrokerRedirectUri(), ctx.sfMyDomainUrl, ctx.codeChallenge),
    finish: async (code, codeVerifier) => {
      const tok = await exchangeCode(code, sfBrokerRedirectUri(), codeVerifier);
      const who = await fetchUserInfo(tok.instance_url, tok.access_token);
      return {
        accessToken:       tok.access_token,
        refreshToken:      tok.refresh_token ?? null,
        tokenExpiresAt:    tok.expires_in ? new Date(Date.now() + Number(tok.expires_in) * 1000) : null,
        scopes:            tok.scope ?? null,
        instanceUrl:       tok.instance_url ?? null,
        accountEmail:      who.email ?? null,
        externalAccountId: who.user_id ?? parseUserIdFromIdUrl(tok.id) ?? null,
      };
    },
  },
  outlook: {
    configured: microsoftConfigured,
    notConfiguredHint: 'Outlook OAuth is not configured — set MS_CLIENT_ID and MS_CLIENT_SECRET in server/.env and register the callback URL on the Azure app.',
    authorizeUrl: buildMicrosoftAuthorizeUrl,
    finish: async (code) => {
      const tok = await exchangeMicrosoftCode(code);
      const who = await fetchMicrosoftUserInfo(tok.access_token);
      return {
        accessToken:       tok.access_token,
        refreshToken:      tok.refresh_token ?? null,
        tokenExpiresAt:    tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
        scopes:            tok.scope ?? null,
        accountEmail:      who.email ?? null,
        externalAccountId: who.id ?? null,
      };
    },
  },
  // The same Google OAuth client, one connection per product with its own
  // scopes: Gmail runs on Archon's server, Drive on Google's hosted MCP
  // server (ConnectorCatalog__mdt.gdrive.McpServerUrl__c points at it).
  gmail:  googleProvider('gmail'),
  gdrive: googleProvider('gdrive'),
};

function googleProvider(key: 'gmail' | 'gdrive'): OAuthProvider {
  return {
    configured: googleConfigured,
    notConfiguredHint: `${key === 'gmail' ? 'Gmail' : 'Google Drive'} OAuth is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in server/.env and register the callback URL on the Google OAuth client.`,
    authorizeUrl: (state) => buildGoogleAuthorizeUrl(state, GOOGLE_SCOPES[key]),
    finish: async (code) => {
      const tok = await exchangeGoogleCode(code);
      const who = await fetchGoogleUserInfo(tok.access_token);
      return {
        accessToken:       tok.access_token,
        refreshToken:      tok.refresh_token ?? null,
        tokenExpiresAt:    tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
        scopes:            tok.scope ?? null,
        accountEmail:      who.email ?? null,
        externalAccountId: who.id ?? null,
      };
    },
  };
}

// ── POST /api/connectors/oauth/start ─────────────────────────────────
// Called by Apex when a user hits Connect. Returns the provider's
// authorize URL; the LWC navigates the browser there.

connectorsRouter.post('/api/connectors/oauth/start', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const providerKey = String(req.body?.providerKey ?? '');
  const displayName = String(req.body?.displayName ?? providerKey);
  const returnUrl   = String(req.body?.returnUrl ?? '');
  // The SF user starting the flow. WHOSE connection this becomes is the
  // principal: 'user' (their own), 'group' (a department's shared account,
  // bound to a subject) or 'org' (the one shared account). A caller that
  // says nothing gets what it always got: a personal row for Salesforce,
  // the org row for everything else.
  const userId      = String(req.body?.userId ?? '') || null;
  const principalRaw = String(req.body?.principalType ?? '');
  const principalType: 'org' | 'group' | 'user' =
    principalRaw === 'user' || principalRaw === 'group' || principalRaw === 'org' ? principalRaw
    : providerKey === 'salesforce_mcp' ? 'user' : 'org';
  const subjectType  = req.body?.subjectType ? String(req.body.subjectType) : null;
  const subjectKey   = req.body?.subjectKey ? String(req.body.subjectKey) : null;
  const subjectLabel = req.body?.subjectLabel ? String(req.body.subjectLabel) : null;
  if (principalType === 'group' && (!subjectType || !subjectKey)) {
    res.status(400).json({ error: 'missing_subject', message: 'A group connection needs subjectType and subjectKey.' });
    return;
  }
  if (principalType === 'user' && !userId) {
    res.status(400).json({ error: 'missing_user', message: 'A personal connection needs userId.' });
    return;
  }

  const provider = OAUTH_PROVIDERS[providerKey];
  if (!provider) {
    res.status(400).json({ error: 'unsupported_provider',
      message: `${displayName} is not wired in this build yet. Supported: Salesforce MCP (via Archon Setup), ${Object.keys(OAUTH_PROVIDERS).join(', ')}.` });
    return;
  }
  if (!provider.configured()) {
    res.status(400).json({ error: 'provider_not_configured', message: provider.notConfiguredHint });
    return;
  }
  if (!returnUrl.startsWith('https://') && !returnUrl.startsWith('http://localhost')) {
    res.status(400).json({ error: 'invalid_return_url', message: 'returnUrl must be an https URL.' });
    return;
  }

  try {
    // A personal row is the caller's own unless an admin named the person
    // (signing in beside them): then it is that person's.
    const connector = await ConnectorsRepo.upsertPending({
      orgId, providerKey, displayName, authType: 'OAuth2', configuredBy: userId,
      principalType, subjectType: principalType === 'user' ? 'user' : subjectType,
      subjectKey: principalType === 'user' ? (subjectKey || userId) : subjectKey, subjectLabel,
    });
    ConnectorsCache.invalidateOrg(orgId);
    forgetGroupConnections(orgId);
    const state = crypto.randomUUID();
    const pkce = provider.pkce ? createPkcePair() : null;
    await PendingOAuthRepo.create({ state, orgId, providerKey, displayName, returnUrl, connectorId: connector.id, codeVerifier: pkce?.verifier ?? null });
    const install = await InstallsRepo.findByOrgId(orgId);
    const authorizeUrl = provider.authorizeUrl(state, { sfMyDomainUrl: install?.sfInstanceUrl ?? null, codeChallenge: pkce?.challenge ?? null });
    logger.info({
      orgId, providerKey, userId,
      connectorId: connector.id,
      state,
      sfMyDomainUrl: install?.sfInstanceUrl ?? null,
      returnUrl,
      authorizeUrl,
    }, 'connector_oauth_started');
    res.json({ connectorId: connector.id, authorizeUrl });
  } catch (err) {
    logger.error({ err, orgId, providerKey }, 'connector_oauth_start_failed');
    res.status(500).json({ error: 'oauth_start_failed', message: (err as Error).message });
  }
});

// ── GET /api/connectors/oauth/callback ───────────────────────────────
// Browser redirect target — NO sessionAuth (the user's browser carries no
// bearer). State ties the callback to the org + connector row.

connectorsRouter.get('/api/connectors/oauth/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query as Record<string, string | undefined>;
  logger.info({
    state,
    hasCode: !!code,
    codeLen: code?.length ?? 0,
    error: error ?? null,
    errorDescription: errorDescription ?? null,
  }, 'connector_oauth_callback_received');

  const pending = state ? await PendingOAuthRepo.consume(state) : null;
  if (!pending) {
    logger.warn({ state }, 'connector_oauth_callback_state_unknown');
    res.status(400).send(callbackPage(false, 'Invalid or expired OAuth state. Close this tab and try Connect again.'));
    return;
  }
  logger.info({ orgId: pending.orgId, providerKey: pending.providerKey, connectorId: pending.connectorId }, 'connector_oauth_callback_state_ok');

  const bounce = (ok: boolean) => {
    try {
      const url = new URL(pending.returnUrl);
      url.searchParams.set('archon_connected', ok ? '1' : '0');
      if (pending.connectorId) url.searchParams.set('connectorId', pending.connectorId);
      res.redirect(url.toString());
    } catch {
      res.send(callbackPage(ok, ok ? 'Connected. You can close this tab.' : 'Connection failed.'));
    }
  };

  if (error || !code) {
    logger.warn({ error, errorDescription, providerKey: pending.providerKey }, 'connector_oauth_denied');
    if (pending.connectorId) await ConnectorsRepo.markError(pending.connectorId, String(errorDescription ?? error ?? 'denied')).catch(() => null);
    bounce(false);
    return;
  }

  const provider = OAUTH_PROVIDERS[pending.providerKey];
  if (!provider || !pending.connectorId) { bounce(false); return; }

  try {
    logger.info({ providerKey: pending.providerKey }, 'connector_oauth_exchanging_code');
    const result = await provider.finish(code, pending.codeVerifier);
    // A person's (or a team's) account must be on the org's allowed
    // domains, if it set any — a personal mailbox signed in against a
    // corporate agent is refused here, before it is ever used.
    const row = await ConnectorsRepo.getById(pending.orgId, pending.connectorId).catch(() => null);
    if (row && row.principalType !== 'org' && !SALESFORCE_TOKEN_PROVIDERS.has(pending.providerKey)) {
      const domains = (await OrgIdentityPolicyRepo.get(pending.orgId)).allowedDomains;
      if (domains.length && !accountMatchesDomains(result.accountEmail ?? null, domains)) {
        const message = `${result.accountEmail ?? 'That account'} is outside the allowed sign-in domain${domains.length === 1 ? '' : 's'} (${domains.join(', ')}). Sign in again with a work account.`;
        logger.warn({ orgId: pending.orgId, providerKey: pending.providerKey, accountEmail: result.accountEmail, domains }, 'connector_oauth_wrong_domain');
        await ConnectorsRepo.markError(pending.connectorId, message).catch(() => null);
        ConnectorsCache.invalidateOrg(pending.orgId);
        bounce(false);
        return;
      }
    }
    await ConnectorsRepo.markConnected(pending.connectorId, result);
    ConnectorsCache.invalidateOrg(pending.orgId);
    forgetGroupConnections(pending.orgId);
    logger.info({
      orgId: pending.orgId,
      providerKey: pending.providerKey,
      accountEmail: result.accountEmail,
      instanceUrl: result.instanceUrl ?? null,
      hasRefreshToken: !!result.refreshToken,
      tokenExpiresAt: result.tokenExpiresAt ?? null,
    }, 'connector_oauth_connected');
    bounce(true);
  } catch (err) {
    logger.error({ err: (err as Error).message, providerKey: pending.providerKey }, 'connector_oauth_finish_failed');
    await ConnectorsRepo.markError(pending.connectorId, (err as Error).message).catch(() => null);
    bounce(false);
  }
});

function callbackPage(ok: boolean, message: string): string {
  return `<html><body style="font-family:-apple-system,sans-serif;padding:2rem;text-align:center">
    <h2>${ok ? '✅ Connected' : '❌ Connection failed'}</h2><p>${message}</p></body></html>`;
}

// ── POST /api/mcp-tools ─────────────────────────────────────────────
// Design-time tool catalog proxy. Salesforce owns the MCP server URL
// (ConnectorCatalog__mdt.McpServerUrl__c) and passes it here; we fetch
// the server's public GET /tools and relay it. Keeps the org's Remote
// Site list to just this Node server.

connectorsRouter.post('/api/mcp-tools', sessionAuth, async (req, res) => {
  const url = String(req.body?.url ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-zA-Z0-9.-]+(:\d+)?$/.test(url) && !/^http:\/\/localhost(:\d+)?$/.test(url)) {
    res.status(400).json({ error: 'invalid_url', message: 'url must be an https origin (no path).' });
    return;
  }
  try {
    // Render free-tier MCP servers answer 502/503 from the edge while the
    // app cold-starts (~20-60s) — retry until the deadline instead of
    // failing the user's first click.
    const deadline = Date.now() + 75_000;
    let lastStatus = 0;
    let lastError  = '';
    let attempt    = 0;
    while (Date.now() < deadline) {
      attempt++;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(30_000, deadline - Date.now()));
        const r = await fetch(`${url}/tools`, { signal: controller.signal });
        clearTimeout(timer);
        if (r.ok) {
          const json = (await r.json()) as { server?: string; tools?: unknown[] };
          if (attempt > 1) logger.info({ url, attempt }, 'mcp_tools_proxy_recovered');
          res.json({ server: json.server ?? null, tools: json.tools ?? [] });
          return;
        }
        lastStatus = r.status;
        if (r.status < 500) break;   // 4xx won't heal on retry
        logger.warn({ url, status: r.status, attempt }, 'mcp_tools_proxy_upstream_5xx_retrying');
      } catch (err) {
        lastError = (err as Error).message;
        logger.warn({ url, attempt, err: lastError }, 'mcp_tools_proxy_fetch_failed_retrying');
      }
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
    logger.warn({ url, lastStatus, lastError, attempt }, 'mcp_tools_proxy_gave_up');
    res.status(502).json({
      error: 'upstream_error',
      message: lastStatus
        ? `MCP server returned ${lastStatus} — it may still be waking up; try again in a minute.`
        : `Could not reach the MCP server: ${lastError || 'timeout'}`,
    });
  } catch (err) {
    logger.warn({ err, url }, 'mcp_tools_proxy_failed');
    res.status(502).json({ error: 'unreachable', message: 'Could not reach the MCP server /tools endpoint.' });
  }
});

// ── POST /api/mcp-tool-schemas ────────────────────────────────────────
// Design-time, AUTHENTICATED tool list WITH real input schemas — used by
// the canvas's generic "Call a Tool" action node to build its param-field
// UI. Different from the public GET /tools catalog (metadata only, no
// schema) and from the old salesforce_mcp-only /api/connectors/:id/tools —
// this works for ANY provider, using the same hybrid token resolution the
// flow engine's call_tool executor uses.
//   Body: { provider, connectorId? } → { tools: [{name, description, inputSchema}] }

connectorsRouter.post('/api/mcp-tool-schemas', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const provider = String(req.body?.provider ?? '');
  const connectorId = req.body?.connectorId ? String(req.body.connectorId) : null;
  if (!provider) {
    res.status(400).json({ error: 'missing_provider' });
    return;
  }
  try {
    const { getOrgConnection } = await import('../salesforce/per-org-connection');
    const { resolveProviderToken } = await import('../chat/adapters/shared');
    const conn = await getOrgConnection(orgId);

    // Custom/client-added MCP servers (providerKey 'custom_<Id>') have no
    // Archon-managed OAuth connector — the URL is trusted directly, same as
    // Claude's own "add a custom MCP server" flow. Any auth the server
    // itself needs happens on its side, not ours.
    const isCustom = provider.startsWith('custom_');
    let baseUrl: string | undefined;
    let token: string | null = null;

    if (isCustom) {
      const customId = provider.slice('custom_'.length);
      const customRes = await pkgConn(conn).query<{ McpServerUrl__c?: string }>(
        `SELECT McpServerUrl__c FROM CustomMcpServer__c WHERE Id = '${customId.replace(/'/g, "\\'")}' AND IsActive__c = true LIMIT 1`,
      );
      baseUrl = customRes.records[0]?.McpServerUrl__c;
    } else {
      const catalogRes = await pkgConn(conn).query<{ McpServerUrl__c?: string }>(
        `SELECT McpServerUrl__c FROM ConnectorCatalog__mdt WHERE DeveloperName = '${provider.replace(/'/g, "\\'")}' LIMIT 1`,
      );
      baseUrl = catalogRes.records[0]?.McpServerUrl__c;
    }
    if (!baseUrl) {
      res.status(404).json({ error: 'provider_not_found', message: `No MCP server URL for provider "${provider}".` });
      return;
    }

    if (!isCustom) {
      const install = await InstallsRepo.findByOrgId(orgId);
      token = await resolveProviderToken({
        orgId, userId: String(req.body?.userId ?? ''), provider, connectorId,
        sfAccessToken: install?.sfAccessToken ?? null,
      });
      if (!token) {
        res.status(409).json({ error: 'not_connected', message: `No connected account for provider "${provider}".` });
        return;
      }
    }

    const tools = await listToolsCached({ remoteUrl: baseUrl, accessToken: token ?? '' });
    res.json({ tools });
  } catch (err) {
    if (err instanceof McpRateLimited) {
      // Not a failure of ours — the tool server is throttling. Say so in
      // the client's vocabulary and let the UI retry, rather than a 502.
      logger.warn({ orgId, provider }, 'mcp_tool_schemas_rate_limited');
      // 429, NOT 503: Apex maps any 502/503 from this server to its
      // "Archon is waking up" retry signal, which would put a wrong
      // explanation in front of the user for a throttled tool host.
      res.status(429).json({
        error: 'tool_server_busy',
        message: err.message,
        retryAfterMs: err.retryAfterMs,
      });
      return;
    }
    logger.error({ err, orgId, provider }, 'mcp_tool_schemas_failed');
    res.status(502).json({ error: 'tool_schemas_failed', message: (err as Error).message });
  }
});

// ── POST /api/sf/custom-actions ──────────────────────────────────────
// Design-time discovery of the org's OWN automation for the custom-tool
// picker: invocable Apex actions + autolaunched Flows, via the standard
// invocable-actions REST API on the org connection.
//   { mode: 'list' }                          → [{ type, name, label }]
//   { mode: 'describe', type, name }          → { label, inputs: [...] }

connectorsRouter.post('/api/sf/custom-actions', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const mode = String(req.body?.mode ?? 'list');
  try {
    const { getOrgConnection } = await import('../salesforce/per-org-connection');
    const conn = await getOrgConnection(orgId);
    const version = '62.0';

    if (mode === 'list') {
      const out: Array<{ type: string; name: string; label: string }> = [];
      for (const type of ['apex', 'flow'] as const) {
        try {
          const r = await conn.request<{ actions?: Array<{ name: string; label?: string }> }>(
            `/services/data/v${version}/actions/custom/${type}`);
          for (const a of r?.actions ?? []) out.push({ type, name: a.name, label: a.label || a.name });
        } catch (err) {
          logger.warn({ orgId, type, err: (err as Error).message }, 'custom_actions_list_failed');
        }
      }
      res.json({ actions: out });
      return;
    }

    if (mode === 'describe') {
      const type = String(req.body?.type ?? '');
      const name = String(req.body?.name ?? '');
      if ((type !== 'apex' && type !== 'flow') || !/^[a-zA-Z0-9_.]{1,255}$/.test(name)) {
        res.status(400).json({ error: 'invalid_action', message: 'type must be apex|flow and name a valid API name.' });
        return;
      }
      const r = await conn.request<{ label?: string; description?: string; inputs?: unknown[]; outputs?: unknown[] }>(
        `/services/data/v${version}/actions/custom/${type}/${encodeURIComponent(name)}`);
      res.json({
        type, name,
        label:       r?.label ?? name,
        description: r?.description ?? null,
        inputs:      r?.inputs ?? [],
        outputs:     r?.outputs ?? [],
      });
      return;
    }

    res.status(400).json({ error: 'invalid_mode', message: "mode must be 'list' or 'describe'." });
  } catch (err) {
    logger.error({ orgId, err: (err as Error).message }, 'custom_actions_failed');
    res.status(502).json({ error: 'sf_unreachable', message: (err as Error).message });
  }
});

// ── POST /api/connectors/my-status ───────────────────────────────────
// Chat users' self-service check: does the given user have a personal
// connection for a provider? Called by the chat panel's connect card.

connectorsRouter.post('/api/connectors/my-status', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const userId = String(req.body?.userId ?? '');
  const providerKey = String(req.body?.providerKey ?? 'salesforce_mcp');
  if (!userId) {
    res.status(400).json({ error: 'missing_user', message: 'userId is required.' });
    return;
  }
  const row = await ConnectorsRepo.getByOrgProviderAndUser(orgId, providerKey, userId);
  res.json({
    connected:       !!row,
    accountEmail:    row?.accountEmail ?? null,
    lastConnectedAt: row?.lastConnectedAt ?? null,
  });
});

// ── GET /api/connectors/users ─────────────────────────────────────────
// Admin roster: every user who has (or attempted) a personal connection
// for a provider in this org — Salesforce access page. Distinct from
// /api/connectors/my-status, which only answers for the calling user.

connectorsRouter.get('/api/connectors/users', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const providerKey = String(req.query.providerKey ?? 'salesforce_mcp');
  const rows = await ConnectorsRepo.listUsersForOrgProvider(orgId, providerKey);
  res.json({
    users: rows.map(r => ({
      configuredBy:     r.configuredBy,
      status:            r.status,
      accountEmail:      r.accountEmail,
      lastConnectedAt:   r.lastConnectedAt,
      lastErrorMessage:  r.lastErrorMessage,
    })),
  });
});

// ── GET /api/connectors ──────────────────────────────────────────────
// Returns the per-org connector directory. SF MCP is synthesized from
// OrgInstall; real Connector rows come from the DB.

connectorsRouter.get('/api/connectors', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const install = await InstallsRepo.findByOrgId(orgId);
  const rows    = await ConnectorsRepo.listForOrg(orgId);

  const out: Array<Record<string, unknown>> = [];

  // Synthesize the Salesforce MCP tile from OrgInstall
  if (install) {
    out.push({
      id:               'salesforce_mcp',   // virtual id
      providerKey:      'salesforce_mcp',
      displayName:      'Salesforce MCP',
      status:           'Connected',
      accountEmail:     install.sfUserEmail,
      lastConnectedAt:  install.configuredAt,
      lastErrorMessage: null,
    });
  }

  for (const r of rows) {
    // salesforce_mcp is represented ONLY by the synthesized OrgInstall tile
    // above in this admin-level directory — a Connector row for it is a
    // PER-USER personal connection (see /api/connectors/oauth/start,
    // configuredBy), a different concept entirely (used by PerUser-mode
    // agents' own "Connect my Salesforce", surfaced separately via
    // /api/connectors/users). Merging both under one providerKey here
    // made the org tile's status flap based on an unrelated personal
    // connection's health — keep them apart.
    if (r.providerKey === 'salesforce_mcp') continue;
    out.push({
      id:               r.id,
      providerKey:      r.providerKey,
      displayName:      r.displayName,
      status:           r.status,
      accountEmail:     r.accountEmail,
      lastConnectedAt:  r.lastConnectedAt,
      lastErrorMessage: r.lastErrorMessage,
    });
  }

  res.json({ connectors: out });
});

// ── DELETE /api/connectors/:id ────────────────────────────────────────

connectorsRouter.delete('/api/connectors/:id', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  if (req.params.id === 'salesforce_mcp') {
    res.status(400).json({ error: 'cannot_delete_setup_connector', message: 'To disconnect Salesforce MCP, reset Archon Setup.' });
    return;
  }
  try {
    const row = await ConnectorsRepo.disconnect(orgId, req.params.id);
    ConnectorsCache.invalidateOrg(orgId);
    res.json({ id: row.id, status: row.status });
  } catch (err) {
    res.status(404).json({ error: 'not_found', message: (err as Error).message });
  }
});

// ── GET /api/connectors/:id/tools ─────────────────────────────────────
// Live tools/list from the standalone MCP server.

connectorsRouter.get('/api/connectors/:id/tools', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  if (!config.salesforce.remoteMcpUrl) {
    res.status(500).json({ error: 'remote_mcp_not_configured', message: 'Set SF_REMOTE_MCP_URL in the server .env.' });
    return;
  }

  // The only id we accept right now is `salesforce_mcp` (synthesized)
  if (req.params.id !== 'salesforce_mcp') {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const install = await InstallsRepo.findByOrgId(orgId);
  if (!install) {
    res.status(409).json({ error: 'not_configured', message: 'Run Archon Setup before requesting tools.' });
    return;
  }

  try {
    const fresh = await ensureFreshInstallToken(install);
    const tools = await mcpListTools({
      remoteUrl:   config.salesforce.remoteMcpUrl,
      accessToken: fresh.sfAccessToken,
    });
    res.json({ tools });
  } catch (err) {
    logger.error({ err, orgId }, 'tools_list_failed');
    res.status(502).json({ error: 'tools_list_failed', message: (err as Error).message });
  }
});

/** Refresh the OrgInstall's SF access token if it's expired or close to it. */
async function ensureFreshInstallToken(install: OrgInstall): Promise<OrgInstall> {
  const skewMs = 60_000;
  const stillValid = !install.tokenExpiresAt || install.tokenExpiresAt.getTime() - Date.now() > skewMs;
  if (stillValid) return install;
  if (!install.sfRefreshToken) {
    throw new Error('SF access token expired and no refresh token on file — admin must re-run Archon Setup.');
  }
  logger.info({ orgId: install.orgId }, 'install_token_refreshing');
  // The shared routine: stores the rotated refresh token and updates the
  // install cache, so the next connection is built from the new tokens.
  return refreshOrgInstall(install);
}

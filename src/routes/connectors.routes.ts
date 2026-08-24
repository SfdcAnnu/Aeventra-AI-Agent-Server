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
import { config } from '../config';
import { sessionAuth } from '../auth/session';
import { InstallsRepo } from '../db/installs.repo';
import { ConnectorsRepo, PendingOAuthRepo } from '../db/connectors.repo';
import { mcpListTools } from '../mcp/clients/streamable-http-client';
import { refreshAccessToken, buildAuthorizeUrl, exchangeCode, fetchUserInfo, parseUserIdFromIdUrl, brokerRedirectUri as sfBrokerRedirectUri } from '../oauth/salesforce';
import {
  googleConfigured,
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
} from '../oauth/google';
import {
  microsoftConfigured,
  buildMicrosoftAuthorizeUrl,
  exchangeMicrosoftCode,
  fetchMicrosoftUserInfo,
} from '../oauth/microsoft';
import type { OrgInstall } from '@prisma/client';

export const connectorsRouter = Router();

// ── OAuth broker — provider registry ─────────────────────────────────
// Each provider knows how to build its authorize URL and finish the
// exchange. Adding Outlook later = one more entry here.

interface OAuthStartCtx {
  /** The org's My Domain (from OrgInstall) — Salesforce authorize must run
   *  there; orgfarm dev orgs error out on generic login.salesforce.com. */
  sfMyDomainUrl?: string | null;
}

interface OAuthProvider {
  configured: () => boolean;
  notConfiguredHint: string;
  authorizeUrl: (state: string, ctx: OAuthStartCtx) => string;
  finish: (code: string) => Promise<{
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
    authorizeUrl: (state, ctx) => buildAuthorizeUrl(state, ['refresh_token', 'api', 'id'], sfBrokerRedirectUri(), ctx.sfMyDomainUrl),
    finish: async (code) => {
      const tok = await exchangeCode(code, sfBrokerRedirectUri());
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
  gmail: {
    configured: googleConfigured,
    notConfiguredHint: 'Gmail OAuth is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in server/.env and register the callback URL on the Google OAuth client.',
    authorizeUrl: buildGoogleAuthorizeUrl,
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
  },
};

// ── POST /api/connectors/oauth/start ─────────────────────────────────
// Called by Apex when a user hits Connect. Returns the provider's
// authorize URL; the LWC navigates the browser there.

connectorsRouter.post('/api/connectors/oauth/start', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const providerKey = String(req.body?.providerKey ?? '');
  const displayName = String(req.body?.displayName ?? providerKey);
  const returnUrl   = String(req.body?.returnUrl ?? '');
  // The SF user starting the flow — connections are PER USER.
  const userId      = String(req.body?.userId ?? '') || null;

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
    const connector = await ConnectorsRepo.upsertPending({
      orgId, providerKey, displayName, authType: 'OAuth2', configuredBy: userId,
    });
    const state = crypto.randomUUID();
    await PendingOAuthRepo.create({ state, orgId, providerKey, displayName, returnUrl, connectorId: connector.id });
    const install = await InstallsRepo.findByOrgId(orgId);
    const authorizeUrl = provider.authorizeUrl(state, { sfMyDomainUrl: install?.sfInstanceUrl ?? null });
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
      url.searchParams.set('synapse_connected', ok ? '1' : '0');
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
    const result = await provider.finish(code);
    await ConnectorsRepo.markConnected(pending.connectorId, result);
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
      const customRes = await conn.query<{ McpServerUrl__c?: string }>(
        `SELECT McpServerUrl__c FROM CustomMcpServer__c WHERE Id = '${customId.replace(/'/g, "\\'")}' AND IsActive__c = true LIMIT 1`,
      );
      baseUrl = customRes.records[0]?.McpServerUrl__c;
    } else {
      const catalogRes = await conn.query<{ McpServerUrl__c?: string }>(
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

    const tools = await mcpListTools({ remoteUrl: baseUrl, accessToken: token ?? '' });
    res.json({ tools });
  } catch (err) {
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
    res.status(400).json({ error: 'cannot_delete_setup_connector', message: 'To disconnect Salesforce MCP, reset Synapse Setup.' });
    return;
  }
  try {
    const row = await ConnectorsRepo.disconnect(orgId, req.params.id);
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
    res.status(409).json({ error: 'not_configured', message: 'Run Synapse Setup before requesting tools.' });
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
    throw new Error('SF access token expired and no refresh token on file — admin must re-run Synapse Setup.');
  }
  logger.info({ orgId: install.orgId }, 'install_token_refreshing');
  const tok = await refreshAccessToken(install.sfRefreshToken);
  return InstallsRepo.upsert({
    orgId:          install.orgId,
    sessionKey:     install.sessionKey,
    sfAccessToken:  tok.access_token,
    sfRefreshToken: tok.refresh_token ?? install.sfRefreshToken,
    sfInstanceUrl:  tok.instance_url ?? install.sfInstanceUrl,
    sfUserId:       install.sfUserId,
    sfUserEmail:    install.sfUserEmail,
    tokenExpiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
    scopes:         tok.scope ?? install.scopes,
  });
}

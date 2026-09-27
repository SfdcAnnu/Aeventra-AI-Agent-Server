/**
 * Salesforce OAuth — server-owned. Tokens never touch a SF custom object.
 *
 * Flow:
 *   1. Admin clicks Connect in LWC → Apex calls /api/connectors/oauth/start
 *      → we generate state + a PKCE verifier, store both in PendingOAuth,
 *        return the SF authorize URL carrying the S256 challenge.
 *   2. Browser navigates to login.salesforce.com → user consents → SF redirects
 *      to <SERVER_PUBLIC_URL>/api/oauth/callback?code=...&state=...
 *   3. We exchange code for tokens, persist on Connector row, redirect the
 *      browser back to the SF Lightning page with ?archon_connected=1.
 */
import crypto from 'node:crypto';
import { config } from '../config';

const TOKEN_PATH     = '/services/oauth2/token';
const AUTHORIZE_PATH = '/services/oauth2/authorize';

/** Sandbox vs prod — pull from env, default to prod. */
function loginHost(): string {
  return (config.salesforce.loginUrl || 'https://login.salesforce.com').replace(/\/+$/, '');
}

export function redirectUri(): string {
  return `${config.serverPublicUrl.replace(/\/+$/, '')}/api/setup/callback`;
}

/** Redirect for PER-USER Salesforce connections via the connector broker. */
export function brokerRedirectUri(): string {
  return `${config.serverPublicUrl.replace(/\/+$/, '')}/api/connectors/oauth/callback`;
}

// ── PKCE (RFC 7636) ─────────────────────────────────────────────────
//
// Every Salesforce authorization this server starts carries a PKCE
// challenge: the org Setup, the per-user Connect and the mobile login. The
// verifier never leaves the server; it waits in the pending-state row and
// is sent only on the code exchange. A stolen authorization code is then
// useless without it, which is what the External Client App's "Require
// PKCE" setting enforces. The client secret is still sent too: this is a
// confidential client, and PKCE adds to the secret rather than replacing it.

export interface PkcePair { verifier: string; challenge: string }

/** A fresh verifier (43 url-safe chars from 32 random bytes) and its S256 challenge. */
export function createPkcePair(): PkcePair {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizeUrl(
  state: string,
  scopes: string[] = ['refresh_token', 'api', 'chatter_api', 'id'],
  redirect: string = redirectUri(),
  authHost?: string | null,
  codeChallenge?: string | null,
): string {
  if (!config.salesforce.mcpClientId) {
    throw new Error('SF_MCP_CLIENT_ID not configured');
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     config.salesforce.mcpClientId,
    redirect_uri:  redirect,
    scope:         scopes.join(' '),
    state,
    prompt:        'login consent',   // identical to the setup flow
  });
  if (codeChallenge) {
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }
  // Authorize on the org's My Domain when we know it — some orgs (orgfarm
  // dev editions especially) reject the generic login host after consent.
  const host = (authHost || loginHost()).replace(/\/+$/, '');
  return `${host}${AUTHORIZE_PATH}?${params.toString()}`;
}

export interface SalesforceTokenResponse {
  access_token: string;
  refresh_token?: string;
  instance_url: string;
  id: string;
  token_type: string;
  scope?: string;
  signature?: string;
  issued_at?: string;
  expires_in?: number;
}

export async function exchangeCode(code: string, redirect: string = redirectUri(), codeVerifier?: string | null): Promise<SalesforceTokenResponse> {
  if (!config.salesforce.mcpClientId || !config.salesforce.mcpClientSecret) {
    throw new Error('SF_MCP_CLIENT_ID / SF_MCP_CLIENT_SECRET not configured');
  }
  const params = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    redirect_uri:  redirect,
    client_id:     config.salesforce.mcpClientId,
    client_secret: config.salesforce.mcpClientSecret,
  });
  // A flow started before PKCE shipped has no verifier; it exchanges without
  // one, which works until the External Client App starts requiring PKCE.
  if (codeVerifier) params.set('code_verifier', codeVerifier);

  const { logger } = await import('../logger');
  logger.info({ tokenUrl: `${loginHost()}${TOKEN_PATH}`, redirectUri: redirect, codeLen: code.length, pkce: !!codeVerifier }, 'sf_exchange_code_request');

  const res = await fetch(`${loginHost()}${TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, 'sf_exchange_code_failed');
    throw new Error(`SF token exchange failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as SalesforceTokenResponse;
  // Don't log full tokens — log shape + first/last 4 chars
  logger.info({
    instance_url: json.instance_url,
    id:           json.id,
    scope:        json.scope,
    expires_in:   json.expires_in,
    access_token_prefix:  json.access_token ? json.access_token.slice(0, 4) + '...' + json.access_token.slice(-4) : null,
    refresh_token_present: !!json.refresh_token,
  }, 'sf_exchange_code_success');
  return json;
}

// ── Refresh, safe under refresh-token rotation ──────────────────────
//
// With rotation on, every refresh returns a NEW refresh token and revokes
// the one that was spent. Two things follow, and both are handled here so
// no caller can get them wrong:
//
//   1. The same refresh token must never be spent twice. Two requests that
//      find the access token stale at the same moment would both refresh;
//      the second would present a token the first just revoked, fail, and
//      the org would look disconnected. Concurrent refreshes of one token
//      share a single call.
//   2. A caller holding a copy read before the rotation (a cache, a row
//      loaded a moment earlier) must still succeed. The result of spending
//      a token is kept for a few minutes, keyed by the token spent, and
//      handed to anyone who arrives with it.
//
// `refresh_token` on the result is always set: the rotated one when
// Salesforce issued one, otherwise the token that was used. Every caller
// stores it, which is what keeps a rotating org connected.

const inFlight = new Map<string, Promise<SalesforceTokenResponse>>();
const recentlySpent = new Map<string, { at: number; result: SalesforceTokenResponse }>();
const SPENT_TTL_MS = 5 * 60 * 1000;

export async function refreshAccessToken(refreshToken: string): Promise<SalesforceTokenResponse> {
  const now = Date.now();
  for (const [k, v] of recentlySpent) if (now - v.at > SPENT_TTL_MS) recentlySpent.delete(k);
  const spent = recentlySpent.get(refreshToken);
  if (spent) return spent.result;
  const running = inFlight.get(refreshToken);
  if (running) return running;

  const call = (async () => {
    const result = await callRefresh(refreshToken);
    const rotated = !!result.refresh_token && result.refresh_token !== refreshToken;
    const out: SalesforceTokenResponse = { ...result, refresh_token: result.refresh_token || refreshToken };
    recentlySpent.set(refreshToken, { at: Date.now(), result: out });
    const { logger } = await import('../logger');
    logger.info({ rotated, expires_in: result.expires_in ?? null }, 'sf_refresh_success');
    return out;
  })();
  inFlight.set(refreshToken, call);
  try {
    return await call;
  } finally {
    inFlight.delete(refreshToken);
  }
}

/** Test hook: forget every in-flight and recently spent refresh. */
export function clearRefreshMemory(): void {
  inFlight.clear();
  recentlySpent.clear();
}

async function callRefresh(refreshToken: string): Promise<SalesforceTokenResponse> {
  if (!config.salesforce.mcpClientId || !config.salesforce.mcpClientSecret) {
    throw new Error('SF_MCP_CLIENT_ID / SF_MCP_CLIENT_SECRET not configured');
  }
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     config.salesforce.mcpClientId,
    client_secret: config.salesforce.mcpClientSecret,
  });
  const res = await fetch(`${loginHost()}${TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SF token refresh failed (${res.status}): ${body}`);
  }
  return (await res.json()) as SalesforceTokenResponse;
}

/** Pull the user id off the SF `id` URL (looks like .../id/<orgId>/<userId>). */
export function parseUserIdFromIdUrl(idUrl: string | undefined): string | null {
  if (!idUrl) return null;
  const parts = idUrl.split('/');
  return parts[parts.length - 1] || null;
}

/** Hit /services/oauth2/userinfo with the access token to grab the email. */
export async function fetchUserInfo(instanceUrl: string, accessToken: string): Promise<{ email?: string; user_id?: string; organization_id?: string }> {
  const res = await fetch(`${instanceUrl.replace(/\/+$/, '')}/services/oauth2/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) return {};
  return (await res.json()) as { email?: string; user_id?: string; organization_id?: string };
}

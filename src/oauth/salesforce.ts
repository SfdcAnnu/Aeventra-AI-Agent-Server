/**
 * Salesforce OAuth — server-owned. Tokens never touch a SF custom object.
 *
 * Flow:
 *   1. Admin clicks Connect in LWC → Apex calls /api/connectors/oauth/start
 *      → we generate state, store it in PendingOAuth, return the SF authorize URL.
 *   2. Browser navigates to login.salesforce.com → user consents → SF redirects
 *      to <SERVER_PUBLIC_URL>/api/oauth/callback?code=...&state=...
 *   3. We exchange code for tokens, persist on Connector row, redirect the
 *      browser back to the SF Lightning page with ?synapse_connected=1.
 */
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

export function buildAuthorizeUrl(
  state: string,
  scopes: string[] = ['refresh_token', 'api', 'chatter_api', 'id'],
  redirect: string = redirectUri(),
  authHost?: string | null,
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

export async function exchangeCode(code: string, redirect: string = redirectUri()): Promise<SalesforceTokenResponse> {
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

  const { logger } = await import('../logger');
  logger.info({ tokenUrl: `${loginHost()}${TOKEN_PATH}`, redirectUri: redirect, codeLen: code.length }, 'sf_exchange_code_request');

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

export async function refreshAccessToken(refreshToken: string): Promise<SalesforceTokenResponse> {
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

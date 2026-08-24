/**
 * Microsoft OAuth — server-owned, powers the Outlook connector.
 * Tokens live on the Node-side Connector row, never on a Salesforce record.
 *
 * Mirrors oauth/google.ts. Uses the same generic broker callback:
 *   <SERVER_PUBLIC_URL>/api/connectors/oauth/callback
 *
 * offline_access is what makes Microsoft issue a refresh token. Note that
 * Microsoft ROTATES refresh tokens on every refresh — always persist the
 * new one.
 */
import { config } from '../config';

const GRAPH_SCOPES = ['openid', 'profile', 'offline_access', 'User.Read', 'Mail.Read', 'Mail.ReadWrite', 'Mail.Send'];

function authBase(): string {
  const tenant = config.microsoft.tenant || 'common';
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
}

export function microsoftRedirectUri(): string {
  return `${config.serverPublicUrl.replace(/\/+$/, '')}/api/connectors/oauth/callback`;
}

export function microsoftConfigured(): boolean {
  return !!(config.microsoft.clientId && config.microsoft.clientSecret);
}

export function buildMicrosoftAuthorizeUrl(state: string): string {
  if (!microsoftConfigured()) {
    throw new Error('Outlook OAuth is not configured on the server — set MS_CLIENT_ID and MS_CLIENT_SECRET in server/.env');
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     config.microsoft.clientId,
    redirect_uri:  microsoftRedirectUri(),
    response_mode: 'query',
    scope:         GRAPH_SCOPES.join(' '),
    state,
    prompt:        'select_account',
  });
  return `${authBase()}/authorize?${params.toString()}`;
}

export interface MicrosoftTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type: string;
}

export async function exchangeMicrosoftCode(code: string): Promise<MicrosoftTokenResponse> {
  const params = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    redirect_uri:  microsoftRedirectUri(),
    client_id:     config.microsoft.clientId,
    client_secret: config.microsoft.clientSecret,
    scope:         GRAPH_SCOPES.join(' '),
  });
  const res = await fetch(`${authBase()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Microsoft token exchange failed (${res.status}): ${body}`);
  }
  return (await res.json()) as MicrosoftTokenResponse;
}

export async function refreshMicrosoftToken(refreshToken: string): Promise<MicrosoftTokenResponse> {
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     config.microsoft.clientId,
    client_secret: config.microsoft.clientSecret,
    scope:         GRAPH_SCOPES.join(' '),
  });
  const res = await fetch(`${authBase()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Microsoft token refresh failed (${res.status}): ${body}`);
  }
  return (await res.json()) as MicrosoftTokenResponse;
}

export async function fetchMicrosoftUserInfo(accessToken: string): Promise<{ id?: string; email?: string }> {
  const res = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName', {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) return {};
  const me = (await res.json()) as { id?: string; mail?: string; userPrincipalName?: string };
  return { id: me.id, email: me.mail ?? me.userPrincipalName };
}

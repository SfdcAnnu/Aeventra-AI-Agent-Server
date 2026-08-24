/**
 * Google OAuth — server-owned, powers the Gmail connector.
 * Tokens live on the Node-side Connector row, never on a Salesforce record.
 *
 * Flow (mirrors oauth/salesforce.ts):
 *   1. User clicks Connect Gmail → Apex → POST /api/connectors/oauth/start
 *      → we store PendingOAuth state, return Google's authorize URL.
 *   2. Browser → Google consent → redirect to
 *      <SERVER_PUBLIC_URL>/api/connectors/oauth/callback?code&state
 *   3. Exchange code, fetch the account email, persist on the Connector
 *      row, bounce the browser back to the Lightning page.
 *
 * access_type=offline + prompt=consent are REQUIRED or Google won't issue
 * a refresh token. Google access tokens live ~1 hour.
 */
import { config } from '../config';

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN     = 'https://oauth2.googleapis.com/token';
const GMAIL_SCOPES     = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.modify'];

export function googleRedirectUri(): string {
  return `${config.serverPublicUrl.replace(/\/+$/, '')}/api/connectors/oauth/callback`;
}

export function googleConfigured(): boolean {
  return !!(config.google.clientId && config.google.clientSecret);
}

export function buildGoogleAuthorizeUrl(state: string): string {
  if (!googleConfigured()) {
    throw new Error('Gmail OAuth is not configured on the server — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in server/.env');
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     config.google.clientId,
    redirect_uri:  googleRedirectUri(),
    scope:         GMAIL_SCOPES.join(' '),
    state,
    access_type:   'offline',
    prompt:        'consent',
  });
  return `${GOOGLE_AUTHORIZE}?${params.toString()}`;
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type: string;
  id_token?: string;
}

export async function exchangeGoogleCode(code: string): Promise<GoogleTokenResponse> {
  const params = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    redirect_uri:  googleRedirectUri(),
    client_id:     config.google.clientId,
    client_secret: config.google.clientSecret,
  });
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${body}`);
  }
  return (await res.json()) as GoogleTokenResponse;
}

export async function refreshGoogleToken(refreshToken: string): Promise<GoogleTokenResponse> {
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     config.google.clientId,
    client_secret: config.google.clientSecret,
  });
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google token refresh failed (${res.status}): ${body}`);
  }
  return (await res.json()) as GoogleTokenResponse;
}

export async function fetchGoogleUserInfo(accessToken: string): Promise<{ id?: string; email?: string }> {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) return {};
  return (await res.json()) as { id?: string; email?: string };
}

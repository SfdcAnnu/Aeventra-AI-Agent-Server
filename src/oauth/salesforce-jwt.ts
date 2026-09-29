/**
 * Salesforce as the current user, with no sign-in click: the JWT bearer
 * flow. The External Client App carries a certificate; the admin
 * pre-authorises a permission set; this server signs a short JWT for a
 * username and Salesforce answers with that user's access token. Sharing
 * rules and field security then apply to the person who asked.
 *
 * Configured with SF_JWT_CLIENT_ID (the ECA consumer key) and
 * SF_JWT_PRIVATE_KEY (the PEM, newlines as \n). Off unless both are set
 * AND the org policy switches it on.
 */
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { logger } from '../logger';

const TOKEN_TTL_MS = 50 * 60 * 1000;   // Salesforce sessions run longer; keep a margin
const cache = new Map<string, { token: string; instanceUrl: string; at: number }>();
const inFlight = new Map<string, Promise<{ access_token: string; instance_url: string }>>();

export function sfJwtConfigured(): boolean {
  return !!(config.sfJwt.clientId && config.sfJwt.privateKey);
}

function privateKey(): string {
  return (config.sfJwt.privateKey ?? '').replace(/\\n/g, '\n');
}

/** A token for this username, minted or from the cache. */
export async function mintSalesforceUserToken(username: string, loginUrl?: string | null): Promise<{ token: string; instanceUrl: string }> {
  if (!sfJwtConfigured()) throw new Error('Salesforce JWT is not configured on the server (SF_JWT_CLIENT_ID, SF_JWT_PRIVATE_KEY).');
  const aud = (loginUrl || config.sfJwt.loginUrl).replace(/\/+$/, '');
  const k = `${aud}|${username}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return { token: hit.token, instanceUrl: hit.instanceUrl };
  const running = inFlight.get(k);
  if (running) { const r = await running; return { token: r.access_token, instanceUrl: r.instance_url }; }

  const call = (async () => {
    const assertion = jwt.sign(
      { iss: config.sfJwt.clientId, sub: username, aud, exp: Math.floor(Date.now() / 1000) + 180 },
      privateKey(),
      { algorithm: 'RS256' },
    );
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
    const res = await fetch(`${aud}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; instance_url?: string; error?: string; error_description?: string };
    if (!res.ok || !json.access_token) {
      throw new Error(`Salesforce JWT for ${username} refused: ${json.error ?? res.status} ${json.error_description ?? ''}`.trim());
    }
    cache.set(k, { token: json.access_token, instanceUrl: json.instance_url ?? '', at: Date.now() });
    logger.info({ username, aud }, 'sf_jwt_minted');
    return { access_token: json.access_token, instance_url: json.instance_url ?? '' };
  })();
  inFlight.set(k, call);
  try {
    const r = await call;
    return { token: r.access_token, instanceUrl: r.instance_url };
  } finally {
    inFlight.delete(k);
  }
}

export function forgetSalesforceUserTokens(): void {
  cache.clear();
}

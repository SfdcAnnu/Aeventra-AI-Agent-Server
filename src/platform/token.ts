/**
 * Per-turn bearer for the platform tool endpoint.
 *
 * The runtime is its own MCP client, so the token is minted and verified
 * by the same process: a short-lived HMAC JWT carrying the org, the user,
 * the session and the agent a turn runs for. Nothing else is trusted from
 * the request. PLATFORM_TOKEN_SECRET pins the secret across instances; a
 * single instance gets a random one at boot.
 */
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { logger } from '../logger';

export interface PlatformPrincipal {
  orgId: string;
  userId: string;
  sessionId: string | null;
  agentApiName: string | null;
}

const TTL_SECONDS = 15 * 60;
let secret: string | null = null;

function signingSecret(): string {
  if (secret) return secret;
  const fromEnv = process.env.PLATFORM_TOKEN_SECRET?.trim();
  if (fromEnv) {
    secret = fromEnv;
  } else {
    secret = randomBytes(32).toString('base64url');
    logger.info('platform_token_secret_generated — set PLATFORM_TOKEN_SECRET to pin it across instances');
  }
  return secret;
}

export function mintPlatformToken(p: PlatformPrincipal): string {
  return jwt.sign(
    { sub: p.userId, org: p.orgId, sid: p.sessionId ?? undefined, agent: p.agentApiName ?? undefined },
    signingSecret(),
    { algorithm: 'HS256', expiresIn: TTL_SECONDS, issuer: 'archon-platform' },
  );
}

export function verifyPlatformToken(token: string): PlatformPrincipal | null {
  try {
    const claims = jwt.verify(token, signingSecret(), { algorithms: ['HS256'], issuer: 'archon-platform' }) as {
      sub?: string; org?: string; sid?: string; agent?: string;
    };
    if (!claims.sub || !claims.org) return null;
    return { orgId: claims.org, userId: claims.sub, sessionId: claims.sid ?? null, agentApiName: claims.agent ?? null };
  } catch {
    return null;
  }
}

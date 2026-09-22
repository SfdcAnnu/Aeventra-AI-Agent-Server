/**
 * Application-layer encryption for the columns that are keys to somebody
 * else's org.
 *
 * `accessToken`, `refreshToken`, `apiKey` and `sessionKey` were ordinary
 * String columns. The schema comment promised encryption "when this moves
 * to managed Postgres", the README listed ENCRYPTION_KEY, and nothing in
 * src/ ever read it. So the database held, in clear text: the bearer every
 * org's Apex uses to call this server, Salesforce refresh tokens (which do
 * not expire), connector access tokens, and customers' own AI provider
 * keys. A dump is standing access to every connected org.
 *
 * Disk encryption does not cover this. It protects a stolen volume; it
 * does nothing about a backup, a read replica, a support export, or a
 * SELECT. The value has to arrive at the database already unreadable.
 *
 * TWO RULES MAKE THIS SAFE TO TURN ON WITH LIVE DATA.
 *
 * `open` accepts plaintext. Every existing row is plaintext, and a read
 * path that threw on them would take down every connected org the moment
 * the key appeared. A value without the version prefix is returned as it
 * is, so encrypting is a migration that can run while the server serves.
 *
 * `seal` without a key returns plaintext rather than throwing. That is
 * today's behaviour, kept deliberately: this ships to a running system,
 * and a server that refuses to boot until an env var exists takes every
 * org down to fix a problem that has been latent for months. The warning
 * at startup says so in as many words, and `npm run secrets:backfill`
 * converts the rows once the key is set.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { logger } from '../logger';

const PREFIX = 'v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;   // GCM's standard nonce length
const KEY_BYTES = 32;

let cached: Buffer | null | undefined;

/** 32 bytes, hex or base64. Undefined when unset or unusable. */
function key(): Buffer | null {
  if (cached !== undefined) return cached;
  const raw = (process.env.ENCRYPTION_KEY ?? '').trim();
  if (!raw) return (cached = null);
  let buf: Buffer | null = null;
  if (/^[0-9a-f]{64}$/i.test(raw)) buf = Buffer.from(raw, 'hex');
  else {
    try {
      const b = Buffer.from(raw, 'base64');
      if (b.length === KEY_BYTES) buf = b;
    } catch { /* not base64 either */ }
  }
  if (!buf) {
    // Loud, and still not fatal: a malformed key must not be read as "no
    // key" silently, or someone believes they have encryption and has not.
    logger.error(
      { length: raw.length },
      'ENCRYPTION_KEY is set but is not 32 bytes (64 hex chars, or base64) — secrets are being stored in CLEAR TEXT',
    );
  }
  return (cached = buf);
}

/** Test seam: the key is read once per process in normal operation. */
export function resetSecretBoxForTests(): void {
  cached = undefined;
}

export function encryptionEnabled(): boolean {
  return key() !== null;
}

/** Store-ready. Plaintext in, `v1:iv:tag:ciphertext` out — or plaintext
 *  back when no key is configured. */
export function seal(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return plain ?? null;
  const k = key();
  if (!k) return plain;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, k, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), body.toString('base64')].join(':');
}

/** Whatever the column holds, as the caller meant it. */
export function open(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === '') return stored ?? null;
  if (!stored.startsWith(`${PREFIX}:`)) return stored;   // a row written before the key existed
  const k = key();
  if (!k) {
    // Sealed value, no key. Returning the ciphertext would send it to
    // Salesforce as a bearer and fail confusingly; null makes the caller's
    // own "not connected" path run.
    logger.error('a sealed secret was read with no ENCRYPTION_KEY set — set the key this data was written with');
    return null;
  }
  const [, ivB64, tagB64, bodyB64] = stored.split(':');
  try {
    const decipher = createDecipheriv(ALGO, k, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(bodyB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, or a tampered row. GCM catches both, and either way this
    // value cannot be trusted or used.
    logger.error('a sealed secret failed to decrypt — wrong ENCRYPTION_KEY, or the row was altered');
    return null;
  }
}

/** True for a value this module wrote. Used by the backfill to skip rows. */
export function isSealed(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && stored.startsWith(`${PREFIX}:`);
}

/** Said once, at startup, so an unencrypted deployment is a choice rather
 *  than an oversight. */
export function warnIfUnencrypted(): void {
  if (encryptionEnabled()) return;
  logger.warn(
    'ENCRYPTION_KEY is not set — Salesforce refresh tokens, connector tokens, session keys and customer ' +
    'API keys are stored in CLEAR TEXT. Set a 32-byte key and run `npm run secrets:backfill`.',
  );
}

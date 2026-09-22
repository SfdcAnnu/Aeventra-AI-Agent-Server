import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { seal, open, isSealed, encryptionEnabled, resetSecretBoxForTests } from '../src/lib/secret-box';

/**
 * These columns are keys to somebody else's Salesforce org. A refresh
 * token does not expire; a session key is the bearer that org's Apex uses
 * to call this server.
 *
 * The two properties that make turning this on safe with live data are the
 * ones most likely to be broken by a later "tidy-up", so they are pinned
 * hardest: a plaintext row still reads, and a value written with no key
 * still reads.
 */
const KEY = 'a'.repeat(64);            // 32 bytes as hex
const OTHER = 'b'.repeat(64);

describe('secret-box', () => {
  beforeEach(() => { delete process.env.ENCRYPTION_KEY; resetSecretBoxForTests(); });
  afterEach(() => { delete process.env.ENCRYPTION_KEY; resetSecretBoxForTests(); });

  const withKey = (k = KEY) => { process.env.ENCRYPTION_KEY = k; resetSecretBoxForTests(); };

  it('round-trips a Salesforce refresh token', () => {
    withKey();
    const token = '5Aep861...aVeryLongRefreshToken';
    expect(open(seal(token))).toBe(token);
  });

  it('does not leave the secret in the stored value', () => {
    withKey();
    const stored = seal('5Aep861SECRET')!;
    expect(stored).not.toContain('5Aep861SECRET');
    expect(isSealed(stored)).toBe(true);
  });

  it('gives a different ciphertext each time, so equal tokens do not look equal', () => {
    withKey();
    expect(seal('same')).not.toBe(seal('same'));
  });

  it('STILL READS ROWS WRITTEN BEFORE THE KEY EXISTED', () => {
    // Every row in the live database is plaintext. If this ever throws,
    // setting the key takes down every connected org.
    withKey();
    expect(open('5Aep861PlaintextFromBefore')).toBe('5Aep861PlaintextFromBefore');
  });

  it('stores plaintext when no key is set, which is today’s behaviour', () => {
    expect(encryptionEnabled()).toBe(false);
    expect(seal('token')).toBe('token');
    expect(open('token')).toBe('token');
  });

  it('refuses a sealed value rather than handing back ciphertext', () => {
    withKey();
    const stored = seal('token')!;
    delete process.env.ENCRYPTION_KEY; resetSecretBoxForTests();
    // Returning the ciphertext would send it to Salesforce as a bearer.
    expect(open(stored)).toBeNull();
  });

  it('refuses a value sealed with a different key', () => {
    withKey();
    const stored = seal('token')!;
    withKey(OTHER);
    expect(open(stored)).toBeNull();
  });

  it('refuses a tampered row — GCM authenticates, it does not just decrypt', () => {
    withKey();
    const [v, iv, tag, body] = seal('token')!.split(':');
    const flipped = Buffer.from(body, 'base64');
    flipped[0] ^= 0xff;
    expect(open([v, iv, tag, flipped.toString('base64')].join(':'))).toBeNull();
  });

  it('treats a malformed key as no key, loudly, rather than half-encrypting', () => {
    withKey('too-short');
    expect(encryptionEnabled()).toBe(false);
    expect(seal('token')).toBe('token');
  });

  it('accepts a base64 key as well as hex', () => {
    withKey(Buffer.alloc(32, 7).toString('base64'));
    expect(encryptionEnabled()).toBe(true);
    expect(open(seal('token'))).toBe('token');
  });

  it('passes null and empty through untouched', () => {
    withKey();
    expect(seal(null)).toBeNull();
    expect(seal('')).toBe('');
    expect(open(null)).toBeNull();
    expect(open(undefined)).toBeNull();
  });

  it('handles unicode and very long values', () => {
    withKey();
    const v = 'कुंजी — key éàü ' + 'x'.repeat(5000);
    expect(open(seal(v))).toBe(v);
  });
});

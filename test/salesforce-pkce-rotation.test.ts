import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';

/**
 * PKCE AND REFRESH-TOKEN ROTATION on the server's Salesforce sign-ins.
 *
 * With the External Client App set to require PKCE, an authorization
 * without a challenge, or an exchange without the verifier, is refused.
 * With rotation on, each refresh revokes the refresh token it spent: store
 * the new one or the org drops off at the next refresh, and never spend
 * one token twice or the second caller fails.
 */

const upserts: Array<Record<string, unknown>> = [];
vi.mock('../src/db/installs.repo', () => ({
  InstallsRepo: {
    upsert: vi.fn(async (row: Record<string, unknown>) => { upserts.push(row); return { ...row }; }),
    findByOrgId: vi.fn(async () => null),
  },
}));

const { config } = await import('../src/config');
(config.salesforce as { mcpClientId: string }).mcpClientId = 'client-id';
(config.salesforce as { mcpClientSecret: string }).mcpClientSecret = 'client-secret';

const sf = await import('../src/oauth/salesforce');
const { refreshOrgInstall } = await import('../src/salesforce/per-org-connection');

type Call = { url: string; body: URLSearchParams };
let calls: Call[] = [];
let respond: (body: URLSearchParams) => Record<string, unknown>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  upserts.length = 0;
  sf.clearRefreshMemory();
  respond = () => ({ access_token: 'AT2', refresh_token: 'RT2', instance_url: 'https://x.my.salesforce.com', id: 'https://login/id/00D/005' });
  globalThis.fetch = vi.fn(async (url: unknown, init?: { body?: string }) => {
    const body = new URLSearchParams(init?.body ?? '');
    calls.push({ url: String(url), body });
    await new Promise(r => setTimeout(r, 5));
    return new Response(JSON.stringify(respond(body)), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('PKCE', () => {
  it('makes an S256 pair: a 43-char verifier whose SHA-256 is the challenge', () => {
    const { verifier, challenge } = sf.createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'));
    expect(sf.createPkcePair().verifier).not.toBe(verifier);
  });

  it('puts the challenge on the authorize URL', () => {
    const url = new URL(sf.buildAuthorizeUrl('st', ['refresh_token', 'api', 'id'], 'https://srv/cb', 'https://org.my.salesforce.com', 'CHAL'));
    expect(url.searchParams.get('code_challenge')).toBe('CHAL');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('sends the verifier, and the secret, on the code exchange', async () => {
    await sf.exchangeCode('CODE', 'https://srv/cb', 'VERIFIER');
    expect(calls[0].body.get('grant_type')).toBe('authorization_code');
    expect(calls[0].body.get('code_verifier')).toBe('VERIFIER');
    expect(calls[0].body.get('client_secret')).toBe('client-secret');
  });

  it('still exchanges a code from a flow started before PKCE', async () => {
    await sf.exchangeCode('CODE', 'https://srv/cb', null);
    expect(calls[0].body.has('code_verifier')).toBe(false);
  });
});

describe('refresh under rotation', () => {
  it('spends one refresh token once, however many callers arrive together', async () => {
    const results = await Promise.all([sf.refreshAccessToken('RT1'), sf.refreshAccessToken('RT1'), sf.refreshAccessToken('RT1')]);
    expect(calls).toHaveLength(1);
    expect(results.every(r => r.refresh_token === 'RT2' && r.access_token === 'AT2')).toBe(true);
  });

  it('hands a late caller holding the spent token the rotated result, without a second call', async () => {
    await sf.refreshAccessToken('RT1');
    const late = await sf.refreshAccessToken('RT1');
    expect(calls).toHaveLength(1);
    expect(late.refresh_token).toBe('RT2');
  });

  it('keeps the same refresh token when Salesforce does not rotate', async () => {
    respond = () => ({ access_token: 'AT2', instance_url: 'https://x', id: 'x' });
    expect((await sf.refreshAccessToken('RT1')).refresh_token).toBe('RT1');
  });

  it('stores the rotated refresh token on the org install', async () => {
    const install = {
      orgId: '00D', sessionKey: 'k', sfAccessToken: 'AT1', sfRefreshToken: 'RT1', sfInstanceUrl: 'https://x',
      sfUserId: null, sfUserEmail: null, tokenExpiresAt: null, scopes: null, configuredAt: new Date(), updatedAt: new Date(),
    };
    const updated = await refreshOrgInstall(install);
    expect(upserts[0]).toMatchObject({ sfAccessToken: 'AT2', sfRefreshToken: 'RT2' });
    expect(updated.sfRefreshToken).toBe('RT2');
  });
});

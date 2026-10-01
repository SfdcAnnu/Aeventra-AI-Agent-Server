import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Whose token a connector call runs with: the person's own, a group's,
 * the org's — in that order, and only as far as the policy allows.
 */
const repo = vi.hoisted(() => ({
  getByOrgProviderAndUser: vi.fn(),
  listGroupConnections: vi.fn(),
  getOrgConnection: vi.fn(),
  getById: vi.fn(),
}));
const membership = vi.hoisted(() => ({ membershipFor: vi.fn(), listGroups: vi.fn() }));
const policyRepo = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../src/db/connectors.repo', () => ({ ConnectorsRepo: repo }));
vi.mock('../src/db/connectors-cache', () => ({ ConnectorsCache: { getByOrgProviderAndUser: repo.getByOrgProviderAndUser, invalidateOrg: vi.fn(), put: vi.fn() } }));
vi.mock('../src/db/identity.repo', () => ({ OrgIdentityPolicyRepo: policyRepo, ServerOverrideRepo: { get: vi.fn(), list: vi.fn() }, RemindersRepo: {} }));
vi.mock('../src/identity/membership', () => membership);
vi.mock('../src/salesforce/per-org-connection', () => ({ getOrgConnection: vi.fn(async () => ({ instanceUrl: 'https://x.my.salesforce.com' })) }));
vi.mock('../src/platform/token', () => ({ mintPlatformToken: vi.fn(async () => 'platform-token') }));
vi.mock('../src/oauth/salesforce-jwt', () => ({ sfJwtConfigured: () => false, mintSalesforceUserToken: vi.fn() }));
vi.mock('../src/db/client', () => ({ prisma: {} }));

import { resolveIdentity, forgetGroupConnections } from '../src/identity/resolver';
import { policyFor, DEFAULT_ORG_POLICY, identityInputFromConfig, accountMatchesDomains } from '../src/identity/policy';

const ORG = { ...DEFAULT_ORG_POLICY };
const row = (over: Record<string, unknown>) => ({
  id: 'c1', orgId: 'o', providerKey: 'gdrive', status: 'Connected', accessToken: 'tok', refreshToken: null, tokenExpiresAt: null,
  principalType: 'user', subjectType: 'user', subjectKey: 'u1', subjectLabel: 'Annu', accountEmail: 'annu@360smsapp.com', instanceUrl: null, ...over,
});

describe('policyFor', () => {
  it('runs as the org when a node says nothing, and honours the legacy PerUser access mode', () => {
    expect(policyFor(null, null, ORG, 'chat')).toMatchObject({ runAs: 'org', fallback: 'none', required: false, automationRunAs: 'org' });
    expect(policyFor(null, 'PerUser', ORG, 'chat')).toMatchObject({ runAs: 'user', fallback: 'none', required: true, automationRunAs: 'triggeringUser' });
  });
  it('lets the org-wide block override a node\'s org fallback in chat, not in automations', () => {
    const input = { runAs: 'user', fallback: 'org' };
    expect(policyFor(input, null, ORG, 'chat').fallback).toBe('none');
    expect(policyFor(input, null, { ...ORG, blockOrgFallbackForChat: false }, 'chat').fallback).toBe('org');
    expect(policyFor(input, null, ORG, 'automation').fallback).toBe('org');
  });
  it('reads the identity keys off a node config and nothing else', () => {
    expect(identityInputFromConfig({ provider: 'gdrive', allowedTools: [] })).toBeNull();
    expect(identityInputFromConfig({ runAs: 'group', required: false })).toEqual({ runAs: 'group', fallback: null, required: false, automationRunAs: null, allowedDomain: null });
  });
  it('matches sign-in domains including subdomains', () => {
    expect(accountMatchesDomains('a@sales.acme.com', ['acme.com'])).toBe(true);
    expect(accountMatchesDomains('a@gmail.com', ['acme.com'])).toBe(false);
    expect(accountMatchesDomains('a@gmail.com', [])).toBe(true);
  });
});

describe('resolveIdentity', () => {
  beforeEach(() => {
    forgetGroupConnections();
    for (const fn of Object.values(repo)) fn.mockReset();
    membership.membershipFor.mockReset();
    policyRepo.get.mockResolvedValue(ORG);
    repo.listGroupConnections.mockResolvedValue([]);
    repo.getOrgConnection.mockResolvedValue(null);
    repo.getById.mockResolvedValue(null);
    membership.membershipFor.mockResolvedValue({ groups: [], username: 'annu@x' });
  });

  const base = { orgId: 'o', userId: 'u1', provider: 'gdrive', kind: 'chat' as const, orgPolicy: ORG };

  it('uses the person\'s own connection when the node runs as the user', async () => {
    repo.getByOrgProviderAndUser.mockResolvedValue(row({}));
    const r = await resolveIdentity({ ...base, policy: policyFor({ runAs: 'user' }, null, ORG, 'chat') });
    expect(r.ok && r.token).toBe('tok');
    expect(r.ok && r.principal).toMatchObject({ type: 'user', subjectKey: 'u1', via: 'connection' });
  });

  it('asks for a connection when they have none and fallback is off', async () => {
    repo.getByOrgProviderAndUser.mockResolvedValue(null);
    repo.getOrgConnection.mockResolvedValue(row({ id: 'org1', principalType: 'org', subjectKey: null }));
    const r = await resolveIdentity({ ...base, policy: policyFor({ runAs: 'user' }, null, ORG, 'chat') });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('needs_connection');
    expect(repo.getOrgConnection).not.toHaveBeenCalled();
  });

  it('falls through to a group connection the person belongs to, then to the org when allowed', async () => {
    repo.getByOrgProviderAndUser.mockResolvedValue(null);
    repo.listGroupConnections.mockResolvedValue([row({ id: 'g1', principalType: 'group', subjectType: 'permissionSet', subjectKey: 'PS1', subjectLabel: 'Sales', accessToken: 'sales-tok' })]);
    membership.membershipFor.mockResolvedValue({ groups: [{ type: 'permissionSet', key: 'PS1', label: 'Sales' }], username: 'annu@x' });
    const r = await resolveIdentity({ ...base, policy: policyFor({ runAs: 'user' }, null, ORG, 'chat') });
    expect(r.ok && r.token).toBe('sales-tok');
    expect(r.ok && r.principal.type).toBe('group');

    forgetGroupConnections();
    repo.listGroupConnections.mockResolvedValue([]);
    repo.getOrgConnection.mockResolvedValue(row({ id: 'org1', principalType: 'org', subjectKey: null, accessToken: 'org-tok' }));
    const open = { ...ORG, blockOrgFallbackForChat: false };
    const r2 = await resolveIdentity({ ...base, orgPolicy: open, policy: policyFor({ runAs: 'user', fallback: 'org' }, null, open, 'chat') });
    expect(r2.ok && r2.token).toBe('org-tok');
    expect(r2.ok && r2.principal.type).toBe('org');
  });

  it('refuses a personal account outside the allowed domain', async () => {
    repo.getByOrgProviderAndUser.mockResolvedValue(row({ accountEmail: 'me@gmail.com' }));
    const strict = { ...ORG, allowedDomains: ['360smsapp.com'] };
    const r = await resolveIdentity({ ...base, orgPolicy: strict, policy: policyFor({ runAs: 'user' }, null, strict, 'chat') });
    expect(!r.ok && r.reason).toBe('wrong_account');
  });

  it('runs as the org: the node\'s chosen connection first, then the newest org connection, then the Setup token for Salesforce', async () => {
    repo.getById.mockResolvedValue(row({ id: 'chosen', principalType: 'org', subjectKey: null, accessToken: 'chosen-tok' }));
    const r = await resolveIdentity({ ...base, policy: policyFor(null, null, ORG, 'chat'), explicitConnectorId: 'chosen' });
    expect(r.ok && r.token).toBe('chosen-tok');
    const r2 = await resolveIdentity({ ...base, provider: 'salesforce_mcp', policy: policyFor(null, null, ORG, 'chat'), sfAccessToken: 'setup-tok' });
    expect(r2.ok && r2.token).toBe('setup-tok');
    expect(r2.ok && r2.principal.via).toBe('setup');
  });

  it('a node that pins a connection uses exactly that one — for everyone, in chat and automations — and nothing else', async () => {
    const pinned = policyFor({ runAs: 'connection' }, null, ORG, 'chat');
    expect(pinned).toMatchObject({ runAs: 'connection', fallback: 'none', required: false, automationRunAs: 'org' });
    repo.getById.mockResolvedValue(row({ id: 'mine', principalType: 'user', subjectKey: 'builder', accountEmail: 'sales.annu@360smsapp.com', accessToken: 'pinned-tok' }));
    repo.getByOrgProviderAndUser.mockResolvedValue(row({ id: 'own', accessToken: 'own-tok' }));
    repo.getOrgConnection.mockResolvedValue(row({ id: 'org1', principalType: 'org', subjectKey: null, accessToken: 'org-tok' }));
    const r = await resolveIdentity({ ...base, policy: pinned, explicitConnectorId: 'mine' });
    expect(r.ok && r.token).toBe('pinned-tok');
    expect(r.ok && r.principal.pinned).toBe(true);
    expect(r.ok && r.principal.accountEmail).toBe('sales.annu@360smsapp.com');
    const auto = await resolveIdentity({ ...base, kind: 'automation', policy: policyFor({ runAs: 'connection' }, null, ORG, 'automation'), explicitConnectorId: 'mine' });
    expect(auto.ok && auto.token).toBe('pinned-tok');
    // A disconnected pinned row is a failure with the reason, never a fall-through to the person's own or the org's.
    repo.getById.mockResolvedValue(row({ id: 'mine', status: 'Disconnected', accountEmail: 'sales.annu@360smsapp.com' }));
    const broken = await resolveIdentity({ ...base, policy: pinned, explicitConnectorId: 'mine' });
    expect(!broken.ok && broken.wanted).toBe('connection');
    expect(!broken.ok && broken.message).toContain('sales.annu@360smsapp.com');
  });

  it('an automation for the triggering user with no identity is a failure, not a silent switch', async () => {
    repo.getByOrgProviderAndUser.mockResolvedValue(null);
    repo.getOrgConnection.mockResolvedValue(row({ id: 'org1', principalType: 'org', subjectKey: null }));
    const r = await resolveIdentity({ ...base, kind: 'automation', policy: policyFor({ runAs: 'user', automationRunAs: 'triggeringUser' }, null, ORG, 'automation') });
    expect(!r.ok && r.wanted).toBe('user');
  });
});

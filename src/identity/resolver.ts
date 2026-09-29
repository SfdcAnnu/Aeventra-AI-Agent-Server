/**
 * identity/resolver — whose token a connector call runs with.
 *
 * One function for every provider and every kind of run. For a connector
 * node's policy and the person behind the turn it answers with a token
 * and the principal it belongs to, or says what is missing:
 *
 *   user  → the person's own connection (or, for Salesforce, a token minted
 *           for them when JWT is on) → a group connection they belong to →
 *           the org connection when fallback allows → needs a connection
 *   group → a group connection they belong to → org when fallback allows →
 *           needs a group connection
 *   org   → the connector node's chosen connection, else the org's newest
 *           Connected one, else (Salesforce) the Setup token
 *
 * Every answer names the principal, so each tool call can say who ran it.
 */
import type { Connector } from '@prisma/client';
import { logger } from '../logger';
import { ConnectorsRepo } from '../db/connectors.repo';
import { ConnectorsCache } from '../db/connectors-cache';
import { OrgIdentityPolicyRepo } from '../db/identity.repo';
import { PLATFORM_PROVIDER, SALESFORCE_TOKEN_PROVIDERS } from '../chat/connector-scope';
import { mintPlatformToken } from '../platform/token';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { membershipFor } from './membership';
import { mintSalesforceUserToken, sfJwtConfigured } from '../oauth/salesforce-jwt';
import { accountMatchesDomains, domainsFor, type IdentityPolicy, type OrgIdentityPolicyView, type RunAs, type RunKind } from './policy';

export interface Principal {
  type: RunAs;
  subjectKey: string | null;
  subjectLabel: string | null;
  connectorId: string | null;
  accountEmail?: string | null;
  /** How the token came to be: a stored connection, a minted JWT, the org Setup token. */
  via: 'connection' | 'jwt' | 'setup' | 'platform';
}

export type IdentityReason = 'needs_connection' | 'needs_group_connection' | 'wrong_account' | 'expired';

export type IdentityResult =
  | { ok: true; token: string; principal: Principal; instanceUrl?: string | null }
  | { ok: false; reason: IdentityReason; message: string; wanted: RunAs };

export interface ResolveArgs {
  orgId: string;
  userId: string;
  provider: string;
  policy: IdentityPolicy;
  kind: RunKind;
  /** The connector node's explicitly chosen connection (an org connection). */
  explicitConnectorId?: string | null;
  sfAccessToken?: string | null;
  sessionId?: string | null;
  agentApiName?: string | null;
  orgPolicy?: OrgIdentityPolicyView;
}

/** Token freshness lives in chat/adapters/shared.ts; injected to avoid a cycle. */
type Freshen = (row: Connector) => Promise<string | null>;
let freshen: Freshen = async row => row.accessToken ?? null;
export function useTokenFreshener(fn: Freshen): void { freshen = fn; }

const GROUP_TTL_MS = 2 * 60_000;
const groupRows = new Map<string, { at: number; rows: Connector[] }>();

async function groupConnections(orgId: string, provider: string): Promise<Connector[]> {
  const k = `${orgId}|${provider}`;
  const hit = groupRows.get(k);
  if (hit && Date.now() - hit.at < GROUP_TTL_MS) return hit.rows;
  const rows = await ConnectorsRepo.listGroupConnections(orgId, provider).catch(() => [] as Connector[]);
  groupRows.set(k, { at: Date.now(), rows });
  return rows;
}

export function forgetGroupConnections(orgId?: string): void {
  for (const k of groupRows.keys()) if (!orgId || k.startsWith(`${orgId}|`)) groupRows.delete(k);
}

const principalOf = (row: Connector, via: Principal['via'] = 'connection'): Principal => ({
  type: (row.principalType as RunAs) ?? 'org',
  subjectKey: row.subjectKey ?? null,
  subjectLabel: row.subjectLabel ?? row.accountEmail ?? null,
  connectorId: row.id,
  accountEmail: row.accountEmail ?? null,
  via,
});

const ok = (token: string, principal: Principal, instanceUrl?: string | null): IdentityResult => ({ ok: true, token, principal, instanceUrl });

/** The effective run-as for this kind of run. */
export function effectiveRunAs(policy: IdentityPolicy, kind: RunKind): RunAs {
  if (kind === 'chat') return policy.runAs;
  switch (policy.automationRunAs) {
    case 'triggeringUser': return policy.runAs === 'group' ? 'group' : 'user';
    case 'agentUser': return 'org';   // a designated agent user is a later step; the org identity stands in
    default: return 'org';
  }
}

export async function resolveIdentity(args: ResolveArgs): Promise<IdentityResult> {
  const { orgId, userId, provider, policy, kind } = args;
  const orgPolicy = args.orgPolicy ?? await OrgIdentityPolicyRepo.get(orgId);
  const wanted = effectiveRunAs(policy, kind);
  const fallbackToOrg = wanted === 'org' || policy.fallback === 'org';

  if (provider === PLATFORM_PROVIDER) {
    const token = await mintPlatformToken({ orgId, userId, sessionId: args.sessionId ?? null, agentApiName: args.agentApiName ?? null });
    return ok(token, { type: 'org', subjectKey: null, subjectLabel: 'Archon', connectorId: null, via: 'platform' });
  }

  const isSf = SALESFORCE_TOKEN_PROVIDERS.has(provider);
  const domains = domainsFor(policy, orgPolicy);

  // 1. The person's own connection.
  if (wanted === 'user') {
    const own = await ConnectorsCache.getByOrgProviderAndUser(orgId, isSf ? 'salesforce_mcp' : provider, userId).catch(() => null);
    if (own) {
      if (!isSf && !accountMatchesDomains(own.accountEmail, domains)) {
        return { ok: false, reason: 'wrong_account', wanted, message: `Your ${provider} account ${own.accountEmail ?? ''} is outside the allowed sign-in domain (${domains.join(', ')}). Connect a work account.` };
      }
      const token = await freshen(own);
      if (token) return ok(token, principalOf(own), own.instanceUrl);
      return { ok: false, reason: 'expired', wanted, message: `Your ${provider} connection expired — reconnect it.` };
    }
    // Salesforce without a click: a token minted for the person.
    if (isSf && orgPolicy.sfJwtEnabled && sfJwtConfigured()) {
      try {
        const conn = await getOrgConnection(orgId);
        const { username } = await membershipFor(conn, orgId, userId);
        if (username) {
          const minted = await mintSalesforceUserToken(username, loginUrlOf(conn.instanceUrl));
          return ok(minted.token, { type: 'user', subjectKey: userId, subjectLabel: username, connectorId: null, via: 'jwt' }, minted.instanceUrl);
        }
      } catch (err) {
        logger.warn({ orgId, userId, err: err instanceof Error ? err.message : err }, 'identity_sf_jwt_failed');
      }
    }
  }

  // 2. A group connection for a group the person belongs to.
  if (wanted === 'user' || wanted === 'group') {
    const rows = await groupConnections(orgId, provider);
    if (rows.length > 0) {
      const conn = await getOrgConnection(orgId).catch(() => null);
      const { groups } = conn ? await membershipFor(conn, orgId, userId) : { groups: [] };
      for (const g of groups) {
        const row = rows.find(r => r.status === 'Connected' && r.subjectType === g.type && r.subjectKey === g.key);
        if (!row) continue;
        const token = await freshen(row);
        if (token) return ok(token, principalOf(row), row.instanceUrl);
      }
    }
    if (!fallbackToOrg) {
      if (wanted === 'group') {
        return { ok: false, reason: 'needs_group_connection', wanted, message: `No ${provider} connection exists for any group you belong to. Ask your admin to connect one for your team.` };
      }
      return { ok: false, reason: 'needs_connection', wanted, message: `This agent uses ${provider} as you. Connect your own ${provider} account to continue.` };
    }
  }

  // 3. The org's shared connection.
  if (args.explicitConnectorId) {
    const row = await ConnectorsRepo.getById(orgId, args.explicitConnectorId).catch(() => null);
    if (row && row.status === 'Connected') {
      const token = await freshen(row);
      if (token) return ok(token, principalOf(row), row.instanceUrl);
    }
  }
  const org = await ConnectorsRepo.getOrgConnection(orgId, provider).catch(() => null);
  if (org) {
    const token = await freshen(org);
    if (token) return ok(token, principalOf(org), org.instanceUrl);
  }
  if (isSf && args.sfAccessToken) {
    return ok(args.sfAccessToken, { type: 'org', subjectKey: null, subjectLabel: 'Archon Setup connection', connectorId: null, via: 'setup' });
  }
  return { ok: false, reason: 'needs_connection', wanted: 'org', message: `The ${provider} connector is not connected for this org yet — connect it on the Connectors page.` };
}

function loginUrlOf(instanceUrl: string | undefined): string | null {
  if (!instanceUrl) return null;
  try {
    const host = new URL(instanceUrl).hostname;
    // A My Domain host accepts the JWT grant directly; sandboxes must use test.salesforce.com.
    if (/\.sandbox\.my\.salesforce\.com$/.test(host) || /--/.test(host)) return 'https://test.salesforce.com';
    return `https://${host}`;
  } catch {
    return null;
  }
}

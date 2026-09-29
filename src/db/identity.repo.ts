/**
 * Org identity policy, per-connector server overrides and connection
 * reminders. Small tables, read on every turn, so each carries a short
 * in-process cache that every write drops.
 */
import { prisma } from './client';
import type { ConnectorServerOverride } from '@prisma/client';
import { seal, open } from '../lib/secret-box';
import { DEFAULT_ORG_POLICY, type OrgIdentityPolicyView } from '../identity/policy';

const TTL_MS = 60_000;
const policyCache = new Map<string, { at: number; view: OrgIdentityPolicyView }>();
const overrideCache = new Map<string, { at: number; rows: ConnectorServerOverride[] }>();

function toView(row: { defaultRunAs: string; defaultFallback: string; blockOrgFallbackForChat: boolean; groupKeyType: string; sfJwtEnabled: boolean; allowedDomainsJson: string | null; reminderEveryDays: number; reminderMax: number } | null): OrgIdentityPolicyView {
  if (!row) return { ...DEFAULT_ORG_POLICY };
  let domains: string[] = [];
  try { domains = row.allowedDomainsJson ? (JSON.parse(row.allowedDomainsJson) as string[]) : []; } catch { domains = []; }
  return {
    defaultRunAs: (row.defaultRunAs as OrgIdentityPolicyView['defaultRunAs']) ?? 'user',
    defaultFallback: (row.defaultFallback as OrgIdentityPolicyView['defaultFallback']) ?? 'none',
    blockOrgFallbackForChat: row.blockOrgFallbackForChat,
    groupKeyType: (row.groupKeyType as OrgIdentityPolicyView['groupKeyType']) ?? 'permissionSet',
    sfJwtEnabled: row.sfJwtEnabled,
    allowedDomains: Array.isArray(domains) ? domains.filter(d => typeof d === 'string') : [],
    reminderEveryDays: row.reminderEveryDays,
    reminderMax: row.reminderMax,
  };
}

export const OrgIdentityPolicyRepo = {
  async get(orgId: string): Promise<OrgIdentityPolicyView> {
    const hit = policyCache.get(orgId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.view;
    const row = await prisma.orgIdentityPolicy.findUnique({ where: { orgId } }).catch(() => null);
    const view = toView(row);
    policyCache.set(orgId, { at: Date.now(), view });
    return view;
  },

  async upsert(orgId: string, patch: Partial<OrgIdentityPolicyView>): Promise<OrgIdentityPolicyView> {
    const data = {
      ...(patch.defaultRunAs ? { defaultRunAs: patch.defaultRunAs } : {}),
      ...(patch.defaultFallback ? { defaultFallback: patch.defaultFallback } : {}),
      ...(patch.blockOrgFallbackForChat != null ? { blockOrgFallbackForChat: patch.blockOrgFallbackForChat } : {}),
      ...(patch.groupKeyType ? { groupKeyType: patch.groupKeyType } : {}),
      ...(patch.sfJwtEnabled != null ? { sfJwtEnabled: patch.sfJwtEnabled } : {}),
      ...(patch.allowedDomains ? { allowedDomainsJson: JSON.stringify(patch.allowedDomains) } : {}),
      ...(patch.reminderEveryDays != null ? { reminderEveryDays: patch.reminderEveryDays } : {}),
      ...(patch.reminderMax != null ? { reminderMax: patch.reminderMax } : {}),
    };
    const row = await prisma.orgIdentityPolicy.upsert({ where: { orgId }, create: { orgId, ...data }, update: data });
    policyCache.delete(orgId);
    return toView(row);
  },

  clearCache(): void { policyCache.clear(); },
};

export const ServerOverrideRepo = {
  async list(orgId: string): Promise<ConnectorServerOverride[]> {
    const hit = overrideCache.get(orgId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
    const rows = (await prisma.connectorServerOverride.findMany({ where: { orgId } }).catch(() => []))
      .map(r => ({ ...r, apiKey: open(r.apiKey) }));
    overrideCache.set(orgId, { at: Date.now(), rows });
    return rows;
  },

  async get(orgId: string, providerKey: string): Promise<ConnectorServerOverride | null> {
    return (await this.list(orgId)).find(r => r.providerKey === providerKey) ?? null;
  },

  async upsert(orgId: string, providerKey: string, patch: { mcpServerUrl: string; authStyle?: string; apiKey?: string | null; updatedBy?: string | null }): Promise<ConnectorServerOverride> {
    const data = {
      mcpServerUrl: patch.mcpServerUrl.replace(/\/+$/, ''),
      authStyle: patch.authStyle ?? 'provider-token',
      apiKey: patch.apiKey === undefined ? undefined : seal(patch.apiKey),
      updatedBy: patch.updatedBy ?? null,
    };
    const row = await prisma.connectorServerOverride.upsert({
      where: { orgId_providerKey: { orgId, providerKey } },
      create: { orgId, providerKey, ...data, apiKey: data.apiKey ?? null },
      update: data,
    });
    overrideCache.delete(orgId);
    return { ...row, apiKey: open(row.apiKey) };
  },

  async remove(orgId: string, providerKey: string): Promise<void> {
    await prisma.connectorServerOverride.deleteMany({ where: { orgId, providerKey } });
    overrideCache.delete(orgId);
  },

  clearCache(): void { overrideCache.clear(); },
};

export const RemindersRepo = {
  async record(orgId: string, providerKey: string, userId: string, agentApiName: string | null, channel: string) {
    return prisma.connectionReminder.upsert({
      where: { orgId_providerKey_userId: { orgId, providerKey, userId } },
      create: { orgId, providerKey, userId, agentApiName, channel },
      update: { count: { increment: 1 }, lastSentAt: new Date(), agentApiName: agentApiName ?? undefined, channel },
    });
  },

  async list(orgId: string, providerKey?: string) {
    return prisma.connectionReminder.findMany({ where: { orgId, ...(providerKey ? { providerKey } : {}) } });
  },

  async forget(orgId: string, providerKey: string, userId: string): Promise<void> {
    await prisma.connectionReminder.deleteMany({ where: { orgId, providerKey, userId } });
  },
};

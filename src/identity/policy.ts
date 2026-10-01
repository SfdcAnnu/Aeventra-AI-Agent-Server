/**
 * identity/policy — whose account an agent's connector runs as.
 *
 * A connector node on the canvas says how it runs: as the person who
 * asked (user), as the department's shared account (group) or as the
 * org's one shared account (org); whether it may fall back to the org
 * connection when the person has none; whether it must be connected
 * before the chat starts; and whose identity an unattended run uses.
 * The org policy sets the defaults and the org-wide switch that blocks
 * falling back to the shared connection in chat.
 *
 * A node that says nothing runs as the org — exactly what every agent did
 * before principals existed. The org default applies to nodes the canvas
 * and the Architect create from now on, never retroactively.
 */
/** 'connection': the node pins ONE stored connection (its connectorId) and
 *  everyone who uses the agent acts as it — a builder's own account, a
 *  team's, or the org's, chosen on the canvas. */
export type RunAs = 'user' | 'group' | 'org' | 'connection';
export type Fallback = 'none' | 'org';
export type AutomationRunAs = 'triggeringUser' | 'agentUser' | 'org';
export type RunKind = 'chat' | 'automation';

export interface IdentityPolicy {
  runAs: RunAs;
  fallback: Fallback;
  /** Chat: the person must connect before the first message. */
  required: boolean;
  automationRunAs: AutomationRunAs;
  /** Sign-in domain a user's own account must belong to (the org policy's list wins when set). */
  allowedDomain?: string | null;
}

/** What Salesforce sends on each connector, straight off the node config. */
export interface IdentityPolicyInput {
  runAs?: string | null;
  fallback?: string | null;
  required?: boolean | null;
  automationRunAs?: string | null;
  allowedDomain?: string | null;
}

export interface OrgIdentityPolicyView {
  defaultRunAs: RunAs;
  defaultFallback: Fallback;
  blockOrgFallbackForChat: boolean;
  groupKeyType: 'permissionSet' | 'publicGroup' | 'department';
  sfJwtEnabled: boolean;
  allowedDomains: string[];
  reminderEveryDays: number;
  reminderMax: number;
}

export const DEFAULT_ORG_POLICY: OrgIdentityPolicyView = {
  defaultRunAs: 'user',
  defaultFallback: 'none',
  blockOrgFallbackForChat: true,
  groupKeyType: 'permissionSet',
  sfJwtEnabled: false,
  allowedDomains: [],
  reminderEveryDays: 3,
  reminderMax: 3,
};

const RUN_AS = new Set<RunAs>(['user', 'group', 'org', 'connection']);
const FALLBACK = new Set<Fallback>(['none', 'org']);
const AUTO = new Set<AutomationRunAs>(['triggeringUser', 'agentUser', 'org']);

/**
 * The policy a connector runs under this turn. Legacy `accessMode`
 * ('PerUser' on the Salesforce connector) still means "as the user, no
 * fallback, required"; a node with no identity keys runs as the org.
 */
export function policyFor(
  input: IdentityPolicyInput | null | undefined,
  legacyAccessMode: string | null | undefined,
  org: OrgIdentityPolicyView,
  kind: RunKind,
): IdentityPolicy {
  const runAsRaw = input?.runAs ?? (legacyAccessMode === 'PerUser' ? 'user' : null);
  const runAs: RunAs = RUN_AS.has(runAsRaw as RunAs) ? (runAsRaw as RunAs) : 'org';
  let fallback: Fallback = FALLBACK.has(input?.fallback as Fallback) ? (input!.fallback as Fallback) : 'none';
  if (runAs === 'org' || runAs === 'connection') fallback = 'none';
  // The org-wide block wins over any node in chat.
  if (kind === 'chat' && org.blockOrgFallbackForChat && runAs !== 'org' && runAs !== 'connection') fallback = 'none';
  // A pinned connection asks nothing of the person chatting.
  const required = runAs === 'connection' ? false
    : input?.required != null ? !!input.required : (legacyAccessMode === 'PerUser' || (runAs !== 'org'));
  const automationRunAs: AutomationRunAs = AUTO.has(input?.automationRunAs as AutomationRunAs)
    ? (input!.automationRunAs as AutomationRunAs)
    : runAs === 'org' || runAs === 'connection' ? 'org' : 'triggeringUser';
  const allowedDomain = (input?.allowedDomain ?? '').trim().toLowerCase() || null;
  return { runAs, fallback, required, automationRunAs, allowedDomain };
}

/** The identity keys a connector node's config carries, as Salesforce sends them. */
export function identityInputFromConfig(cfg: Record<string, unknown> | null | undefined): IdentityPolicyInput | null {
  if (!cfg) return null;
  const pick = (k: string) => (typeof cfg[k] === 'string' ? (cfg[k] as string) : null);
  const out: IdentityPolicyInput = {
    runAs: pick('runAs'),
    fallback: pick('fallback'),
    required: typeof cfg.required === 'boolean' ? (cfg.required as boolean) : null,
    automationRunAs: pick('automationRunAs'),
    allowedDomain: pick('allowedDomain'),
  };
  return out.runAs || out.fallback || out.required != null || out.automationRunAs || out.allowedDomain ? out : null;
}

/** The policy a NEW connector node starts with, from the org defaults. */
export function defaultNodePolicy(org: OrgIdentityPolicyView): IdentityPolicyInput {
  return { runAs: org.defaultRunAs, fallback: org.defaultFallback, required: org.defaultRunAs !== 'org', automationRunAs: org.defaultRunAs === 'org' ? 'org' : 'triggeringUser' };
}

/** The sign-in domains an account must match: the node's, else the org's list. */
export function domainsFor(policy: IdentityPolicy, org: OrgIdentityPolicyView): string[] {
  if (policy.allowedDomain) return [policy.allowedDomain];
  return org.allowedDomains.map(d => d.trim().toLowerCase()).filter(Boolean);
}

export function accountMatchesDomains(accountEmail: string | null | undefined, domains: string[]): boolean {
  if (domains.length === 0) return true;
  const at = (accountEmail ?? '').toLowerCase().split('@')[1] ?? '';
  return !!at && domains.some(d => at === d || at.endsWith(`.${d}`));
}

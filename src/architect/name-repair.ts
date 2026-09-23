/**
 * THE SPELLING IS NOT A DESIGN DECISION, SO IT IS NOT A PAID RETRY.
 *
 * The validator rejects any tool or object name that is not exactly what
 * the Surveyor found, and the designer reshapes names into the casing it
 * expects: `get_sobject_schema` for a server that publishes
 * `getObjectSchema`, `lead` for `Lead`, `insert` for `create`. Each
 * rejection used to send the whole design back to the large-tier model
 * for another emit — $0.25 to $0.55 and a minute of reasoning — to fix a
 * fact no model needs to supply. A build spent three attempts and $1.65
 * that way and saved nothing.
 *
 * This corrects what is unambiguous and leaves the rest to the validator:
 * a name is repaired only when exactly one available name plainly means
 * it. A verb is never changed — `updateSobjectRecord` will not become
 * `createSobjectRecord` however similar they look — because a wrong tool
 * is worse than a rejected one.
 */
import type { AgentSpec, SpecNode } from './spec';

export interface AvailableNames {
  mcp: Array<{ connector: string; tools: string[] }>;
  crud: Array<{ sobject: string; operations: string[] }>;
  invocables?: Array<{ kind: 'apex' | 'flow'; name: string }>;
}

type Operation = NonNullable<NonNullable<SpecNode['action']>['operation']>;

const OPERATION_ALIASES: Record<string, Operation> = {
  create: 'create', insert: 'create', add: 'create', new: 'create',
  update: 'update', edit: 'update', modify: 'update', change: 'update', set: 'update', patch: 'update',
  upsert: 'upsert',
  delete: 'delete', remove: 'delete',
  query: 'query', read: 'query', select: 'query', find: 'query', search: 'query', get: 'query', lookup: 'query', list: 'query', fetch: 'query',
};

/** Case, underscores, dots and dashes are the differences we forgive. */
function key(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The words of a camelCase or snake_case name, lower-cased. */
function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+|\s+/)
    .filter(Boolean)
    .map(w => w.toLowerCase());
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i + 1 < s.length; i++) {
    const b = s.slice(i, i + 2);
    out.set(b, (out.get(b) ?? 0) + 1);
  }
  return out;
}

/** Sørensen–Dice similarity of two strings' bigram multisets, 0..1. */
export function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ba = bigrams(a);
  const bb = bigrams(b);
  let shared = 0;
  for (const [g, n] of ba) shared += Math.min(n, bb.get(g) ?? 0);
  return (2 * shared) / (a.length - 1 + b.length - 1);
}

const SIMILARITY_FLOOR = 0.75;

/**
 * The one candidate `wanted` plainly means, or null.
 *
 * Exact wins. Then the same letters in a different case or with different
 * separators. Then a close spelling — but only with the same leading verb
 * and only when one candidate is clearly closest, so `findRecord` may
 * become `find_record` and never `createRecord`.
 */
export function closestName(wanted: string, candidates: string[]): string | null {
  if (!wanted) return null;
  if (candidates.includes(wanted)) return wanted;
  // A connector prefix the designer added: "salesforce_mcp.createSobjectRecord".
  const bare = wanted.split(/[.:/]/).pop() ?? wanted;
  if (bare !== wanted && candidates.includes(bare)) return bare;

  const k = key(bare);
  const sameLetters = candidates.filter(c => key(c) === k);
  if (sameLetters.length === 1) return sameLetters[0];
  if (sameLetters.length > 1) return null;

  const verb = words(bare)[0];
  let best: string | null = null;
  let bestScore = 0;
  let tie = false;
  for (const c of candidates) {
    if (words(c)[0] !== verb) continue;
    const s = dice(k, key(c));
    if (s > bestScore) { best = c; bestScore = s; tie = false; }
    else if (s === bestScore && s > 0) tie = true;
  }
  return best !== null && bestScore >= SIMILARITY_FLOOR && !tie ? best : null;
}

/** `Lead` for `lead`; `Project__c` for `Project` or `project__C`; never a guess between two. */
function closestObject(wanted: string, objects: string[]): string | null {
  if (objects.includes(wanted)) return wanted;
  const k = key(wanted);
  const same = objects.filter(o => key(o) === k);
  if (same.length === 1) return same[0];
  if (same.length > 1) return null;
  // The custom-object suffix left off.
  const custom = objects.filter(o => o.endsWith('__c') && key(o.slice(0, -3)) === k);
  return custom.length === 1 ? custom[0] : null;
}

/**
 * Repair the names in `spec` in place and say what changed, one sentence
 * per correction, for the build notes. Anything not plainly repairable is
 * left exactly as written for the validator to report.
 */
export function repairNames(spec: AgentSpec, available: AvailableNames): string[] {
  if (!Array.isArray(spec?.nodes)) return [];
  const notes: string[] = [];

  const toolConnectors = new Map<string, string[]>();
  for (const s of available.mcp ?? []) {
    for (const t of s.tools ?? []) {
      const list = toolConnectors.get(t);
      if (list) list.push(s.connector);
      else toolConnectors.set(t, [s.connector]);
    }
  }
  const mcpNames = [...toolConnectors.keys()];
  const objects = (available.crud ?? []).map(c => c.sobject);
  const opsOf = new Map((available.crud ?? []).map(c => [c.sobject, new Set(c.operations ?? [])]));
  const invocableNames = (kind: 'apex' | 'flow') => (available.invocables ?? []).filter(i => i.kind === kind).map(i => i.name);

  for (const n of spec.nodes) {
    if (n.type !== 'tool' || !n.action) continue;
    const a = n.action;

    if (a.kind === 'mcp' && a.toolName) {
      const fixed = closestName(a.toolName, mcpNames);
      if (fixed && fixed !== a.toolName) {
        notes.push(`'${n.label}' named the tool \`${a.toolName}\`; the server publishes \`${fixed}\` — corrected.`);
        a.toolName = fixed;
      }
      const publishers = toolConnectors.get(a.toolName);
      if (publishers && publishers.length > 0 && (!a.connector || !publishers.includes(a.connector))) {
        if (publishers.length === 1 || !a.connector) {
          const was = a.connector;
          a.connector = publishers[0];
          if (was) notes.push(`'${n.label}' pointed at connector \`${was}\`; \`${a.toolName}\` is published by \`${a.connector}\` — corrected.`);
        }
      }
      continue;
    }

    if (a.kind === 'crud') {
      if (a.sobject) {
        const fixed = closestObject(a.sobject, objects);
        if (fixed && fixed !== a.sobject) {
          notes.push(`'${n.label}' named the object \`${a.sobject}\`; the org calls it \`${fixed}\` — corrected.`);
          a.sobject = fixed;
        }
      }
      if (a.operation) {
        const raw = String(a.operation).toLowerCase();
        const op = OPERATION_ALIASES[raw];
        const allowed = a.sobject ? opsOf.get(a.sobject) : undefined;
        if (op && op !== a.operation && (!allowed || allowed.has(op))) {
          notes.push(`'${n.label}' asked for operation \`${a.operation}\`; that is \`${op}\` here — corrected.`);
          a.operation = op;
        }
      }
      continue;
    }

    if ((a.kind === 'apex_invocable' || a.kind === 'flow_invocable') && a.toolName) {
      const fixed = closestName(a.toolName, invocableNames(a.kind === 'apex_invocable' ? 'apex' : 'flow'));
      if (fixed && fixed !== a.toolName) {
        notes.push(`'${n.label}' named \`${a.toolName}\`; the org has \`${fixed}\` — corrected.`);
        a.toolName = fixed;
      }
    }
  }
  return notes;
}

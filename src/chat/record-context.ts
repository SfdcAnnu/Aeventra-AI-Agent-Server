/**
 * record-context — hand the agent the record it is anchored to, instead of
 * making it rediscover the same one every turn.
 *
 * Measured on a live 4-turn conversation: every turn opened with the same
 * five tool calls (object schema → related record → anchored record →
 * read_artifact → the same record again) purely to learn facts the platform
 * already knew. Each
 * tool round-trip forces another model call, and each model call re-sends
 * the whole ~4,000-token prefix, so rediscovery — not the conversation —
 * was the bulk of the bill and nearly all of the latency.
 *
 * GENERIC BY CONSTRUCTION. It reads whatever fields the anchored record
 * actually has and shows the populated ones. No object, field or use case
 * is named here — the platform supplies mechanics, the agent's own data
 * supplies meaning.
 */
import { getOrgConnection } from '../salesforce/per-org-connection';
import { logger } from '../logger';

const envInt = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Long text fields (descriptions, notes) would otherwise dominate. */
const MAX_VALUE_CHARS = envInt('RECORD_CONTEXT_MAX_VALUE_CHARS', 300);
/** Ceiling for the whole block, so a wide object cannot flood the prompt. */
const MAX_BLOCK_CHARS = envInt('RECORD_CONTEXT_MAX_CHARS', 4_000);
/** A turn makes several model calls; they must not each re-read the row. */
const TTL_MS = envInt('RECORD_CONTEXT_TTL_MS', 60_000);

/** Audit and plumbing columns: true of every object, useful to no agent. */
const NOISE_FIELDS = new Set([
  'attributes', 'IsDeleted', 'SystemModstamp', 'LastViewedDate', 'LastReferencedDate',
  'CreatedById', 'LastModifiedById', 'LastActivityDate', 'PushCount',
  'ConnectionReceivedId', 'ConnectionSentId', 'UserRecordAccessId',
]);

interface CacheEntry { block: string | null; loadedAt: number }
const cache = new Map<string, CacheEntry>();

function isNoise(key: string): boolean {
  return NOISE_FIELDS.has(key) || key.endsWith('__History') || key.startsWith('LastAmountChanged') ||
    key.startsWith('LastCloseDateChanged');
}

function renderValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') {
    // A parent lookup comes back as a nested object. Its Name is the useful
    // part; the rest is another record's plumbing.
    const nested = value as Record<string, unknown>;
    const label = nested.Name ?? nested.Subject ?? nested.CaseNumber;
    return typeof label === 'string' ? label : null;
  }
  const text = String(value);
  return text.length > MAX_VALUE_CHARS ? text.slice(0, MAX_VALUE_CHARS) + '…' : text;
}

/**
 * The anchored record's current values as a compact block, or null when
 * there is no record, it cannot be read, or nothing useful came back.
 *
 * Never throws: a failure here must degrade to the agent looking things up
 * itself — exactly today's behaviour — not break the turn.
 */
// ── the object an Id belongs to ────────────────────────────────────
// A Flow hands the runtime a record Id and no type (headless.ts sends
// recordContextType: null), and the gate below did nothing with it -- so
// a trigger run never got the prefetch a chat on the same record gets,
// and spent a tool call rediscovering fields it could have been handed.
// The first three characters of an Id name the object; describeGlobal
// says which, once an hour per org.
const prefixCache = new Map<string, { map: Map<string, string>; at: number }>();
const PREFIX_TTL_MS = 60 * 60_000;

export async function sobjectTypeFromId(orgId: string, recordId: string): Promise<string | null> {
  if (!recordId || recordId.length < 15) return null;
  let entry = prefixCache.get(orgId);
  if (!entry || Date.now() - entry.at > PREFIX_TTL_MS) {
    try {
      const conn = await getOrgConnection(orgId);
      const g = await conn.describeGlobal();
      const map = new Map<string, string>();
      for (const so of g.sobjects) if (so.keyPrefix) map.set(so.keyPrefix, so.name);
      entry = { map, at: Date.now() };
      prefixCache.set(orgId, entry);
    } catch {
      return null;
    }
  }
  return entry.map.get(recordId.slice(0, 3)) ?? null;
}

// ── the object's picklist options, on every turn ───────────────────
// A live agent read the Lead schema, received Commercial's two projects
// correctly, and eight messages later offered the customer "Commercial
// Project C" -- which does not exist -- and accepted it. A tool result far
// back in the history is weak; a fact in the system prompt on the current
// turn is strong. So the record block carries the object's picklist
// options and their dependencies, decoded from the same validFor bitmaps
// the CRM MCP server decodes, from a describe cached per object.
//
// Bounded by a budget, not by a list of field names: every picklist that
// fits, custom fields first (they are the org's own vocabulary and the
// ones an agent is most often asked to fill), then standard ones, until
// the character cap; a field with more values than a person would be
// offered is named but not listed; what did not fit is counted. No object
// or field is named here -- the platform supplies mechanics, the org's
// schema supplies meaning.
const DESCRIBE_TTL_MS = 5 * 60_000;
const MAX_VALUES_PER_FIELD = 40;
const MAX_OPTIONS_CHARS = 2_000;

interface PicklistEntry { value: string; active?: boolean; validFor?: string | null }
interface DescribedField { name: string; type?: string; controllerName?: string | null; picklistValues?: PicklistEntry[] }

const describeCache = new Map<string, { fields: DescribedField[]; at: number }>();

/** The parent values that switch a dependent value on. Buffer.from never
 *  throws on bad base64 -- it returns plausible bytes -- so the shape is
 *  checked first; wrong is worse than absent here. */
function decodeValidFor(validFor: string | null | undefined, parents: string[]): string[] {
  if (!validFor || parents.length === 0) return [];
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(validFor) || validFor.length % 4 !== 0) return [];
  const bytes = Buffer.from(validFor, 'base64');
  const on: string[] = [];
  for (let i = 0; i < parents.length; i++) {
    const byte = bytes[i >> 3];
    if (byte === undefined) break;
    if (byte & (0x80 >> (i % 8))) on.push(parents[i]);
  }
  return on;
}

async function describedFields(conn: { sobject: (t: string) => { describe: () => Promise<unknown> } }, orgId: string, recordType: string): Promise<DescribedField[]> {
  const key = `${orgId}|${recordType}`;
  const hit = describeCache.get(key);
  if (hit && Date.now() - hit.at < DESCRIBE_TTL_MS) return hit.fields;
  const d = (await conn.sobject(recordType).describe()) as { fields?: DescribedField[] };
  const fields = d.fields ?? [];
  describeCache.set(key, { fields, at: Date.now() });
  return fields;
}

function renderPicklistOptions(recordType: string, fields: DescribedField[]): string | null {
  const byName = new Map(fields.map(f => [f.name, f]));
  const candidates = fields
    .filter(f => (f.type === 'picklist' || f.type === 'combobox') && (f.picklistValues ?? []).some(v => v.active !== false))
    .sort((a, b) => Number(b.name.endsWith('__c')) - Number(a.name.endsWith('__c')));
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const f of candidates) {
    const active = (f.picklistValues ?? []).filter(v => v.active !== false);
    let line: string;
    if (active.length > MAX_VALUES_PER_FIELD) {
      line = `- ${f.name}: ${active.length} values; read the schema if needed`;
    } else {
      line = `- ${f.name}: ${active.map(v => v.value).join(' | ')}`;
      const controller = f.controllerName ? byName.get(f.controllerName) : undefined;
      const parents = controller?.type === 'boolean' ? ['false', 'true'] : (controller?.picklistValues ?? []).map(v => v.value);
      if (f.controllerName && parents.length > 0) {
        const map = new Map<string, string[]>(parents.map(p => [p, []]));
        let any = false;
        for (const v of active) for (const parent of decodeValidFor(v.validFor, parents)) { map.get(parent)!.push(v.value); any = true; }
        if (any) {
          const parts = parents.filter(p => (map.get(p) ?? []).length > 0).map(p => `${p}: ${map.get(p)!.join(' | ')}`);
          line = `- ${f.name} (depends on ${f.controllerName}): ${parts.join('; ')}`;
        }
      }
    }
    if (used + line.length + 1 > MAX_OPTIONS_CHARS) { omitted++; continue; }
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return null;
  if (omitted > 0) lines.push(`- (${omitted} more picklist field${omitted === 1 ? '' : 's'} not listed; read the schema if needed)`);
  return `PICKLIST OPTIONS FOR ${recordType.toUpperCase()} (exact values; offer and save only these, and for a dependent field only the values listed under the chosen parent):\n${lines.join('\n')}`;
}

export async function buildRecordContextBlock(
  orgId: string,
  recordType: string | null | undefined,
  recordId: string | null | undefined,
): Promise<string | null> {
  if (!recordType && orgId && recordId) recordType = await sobjectTypeFromId(orgId, recordId);
  if (!orgId || !recordType || !recordId) return null;

  const key = `${orgId}|${recordType}|${recordId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.loadedAt < TTL_MS) return hit.block;

  let block: string | null = null;
  try {
    const conn = await getOrgConnection(orgId);
    const record = (await conn.sobject(recordType).retrieve(recordId)) as unknown as Record<string, unknown>;

    const lines: string[] = [];
    for (const [field, raw] of Object.entries(record)) {
      if (isNoise(field)) continue;
      const value = renderValue(raw);
      if (value === null) continue;
      lines.push(`${field}: ${value}`);
    }

    if (lines.length > 0) {
      let body = lines.join('\n');
      if (body.length > MAX_BLOCK_CHARS) body = body.slice(0, MAX_BLOCK_CHARS) + '\n…(truncated)';
      block =
        `THE ${recordType.toUpperCase()} THIS CONVERSATION IS ABOUT (current values, read just now — ` +
        `treat these as accurate and do NOT look them up again):\n${body}`;
    }
    if (block) {
      // Fail-soft: a describe that cannot be read costs the options, never the record.
      try {
        const options = renderPicklistOptions(recordType, await describedFields(conn, orgId, recordType));
        if (options) block = block + '\n\n' + options;
      } catch (err) {
        logger.warn({ orgId, recordType, err: err instanceof Error ? err.message : err }, 'record_context_describe_failed');
      }
    }
    logger.info({ orgId, recordType, recordId, fields: lines.length }, 'record_context_loaded');
  } catch (err) {
    // Anything at all — no access, bad id, object not readable — means the
    // agent simply works the way it did before.
    logger.warn(
      { orgId, recordType, recordId, err: err instanceof Error ? err.message : err },
      'record_context_failed',
    );
    block = null;
  }

  cache.set(key, { block, loadedAt: Date.now() });
  if (cache.size > 500) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return block;
}

/** A write to this record: the next turn must see what was written, not
 *  the values from before. Keys end with the record Id, whatever the org. */
export function invalidateRecordContext(recordId: string): void {
  for (const k of cache.keys()) if (k.endsWith(`|${recordId}`)) cache.delete(k);
}

/** Tests only. */
export function _clearRecordContextCaches(): void {
  cache.clear();
  describeCache.clear();
  prefixCache.clear();
}

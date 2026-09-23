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

/**
 * tool-result-cache — one session never runs the same read twice.
 *
 * Live-diagnosed: an agent issued the byte-identical record query on two
 * turns three apart, plus four more near-identical reads of the same
 * record across one conversation. Nothing anywhere remembered that a read
 * had already been answered.
 *
 * The replay fixes (chat/tool-replay.ts) are what stop the model NEEDING to
 * re-ask. This is the backstop for when it asks anyway: same session, same
 * tool, same arguments → the stored answer, no MCP round trip. That also
 * takes real load off the Salesforce MCP host, whose rate limiter has
 * answered 429 on busy conversations before.
 *
 * CORRECTNESS RULES — the cache must never be able to lie:
 *
 *  1. Writes are NEVER cached. A write tool always executes.
 *  2. A write INVALIDATES every cached read in its session. Otherwise an
 *     agent that updates a record and then re-reads it would be handed the
 *     pre-update value — a far worse bug than the one being fixed.
 *  3. Failures are never cached: errors, rejected arguments, and calls
 *     parked for approval all stay repeatable, so a transient failure can't
 *     become sticky for the rest of the session.
 *
 * In-process and bounded, matching the single-instance stance of the MCP
 * connection cache and the artifact store; a restart simply re-reads.
 */
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { logger } from '../logger';
import { isWriteToolName } from '../chat/output-guardrails';
import { fnv1a } from '../util/hash';

const envInt = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const TTL_MS = envInt('TOOL_RESULT_CACHE_TTL_MS', 15 * 60 * 1000);
const MAX_ENTRIES = envInt('TOOL_RESULT_CACHE_MAX_ENTRIES', 500);
/** A result far larger than this is already an artifact reference or is
 *  cheap to re-derive; don't hold it in memory for the whole session. */
const MAX_RESULT_CHARS = envInt('TOOL_RESULT_CACHE_MAX_CHARS', 40_000);

interface Entry { sessionId: string; result: string; storedAt: number }

const store = new Map<string, Entry>();

/** Results that mean "this call did not produce an answer" — never cached.
 *  PENDING_APPROVAL/REJECTED/BLOCKED are the approval-gate and argument
 *  pre-flight signals (approval-gate.ts, mcp-tools.ts). */
const NON_ANSWER_RE = /^\s*(Error\b|REJECTED\b|PENDING_APPROVAL\b|BLOCKED\b)/;

/** Stable key regardless of argument key order — the model does not emit
 *  object keys in a fixed order, and `{a,b}` must hit `{b,a}`.
 *
 *  Short argument sets (the overwhelming majority — a SOQL string, an
 *  object name) key on their exact text, so a collision is impossible. Only
 *  large ones fall back to a hash, and they carry their length alongside it:
 *  fnv1a is 32-bit, and serving one query's rows as the answer to a
 *  different query is exactly the class of lie this cache must not tell. */
function argsKey(args: unknown): string {
  const json = JSON.stringify(canonical(args)) ?? 'null';
  return json.length <= 512 ? json : `${json.length}:${fnv1a(json)}`;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonical(src[k]);
    return out;
  }
  return value;
}

function sweep(): void {
  const now = Date.now();
  for (const [k, e] of store) {
    if (now - e.storedAt > TTL_MS) store.delete(k);
  }
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Drop every cached read for one session — called whenever that session
 *  performs a write (rule 2 above). */
export function invalidateSession(sessionId: string): void {
  let dropped = 0;
  for (const [k, e] of store) {
    if (e.sessionId === sessionId) { store.delete(k); dropped++; }
  }
  if (dropped > 0) logger.info({ sessionId, dropped }, 'tool_result_cache_invalidated');
}

function wrap(t: StructuredToolInterface, sessionId: string): StructuredToolInterface {
  const isWrite = isWriteToolName(t.name);
  return tool(
    async (args: unknown) => {
      if (isWrite) {
        // Always executes. Invalidate AFTER the write lands so a read
        // racing alongside it can't repopulate the cache with stale data.
        const result = await t.invoke(args as never);
        invalidateSession(sessionId);
        return result;
      }

      const key = `${sessionId}|${t.name}|${argsKey(args)}`;
      const hit = store.get(key);
      if (hit && Date.now() - hit.storedAt < TTL_MS) {
        logger.info({ tool: t.name, sessionId, chars: hit.result.length }, 'tool_result_cache_hit');
        return hit.result;
      }
      if (hit) store.delete(key);

      const result = await t.invoke(args as never);
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      if (text && text.length <= MAX_RESULT_CHARS && !NON_ANSWER_RE.test(text)) {
        sweep();
        store.set(key, { sessionId, result: text, storedAt: Date.now() });
      }
      return result;
    },
    { name: t.name, description: t.description, schema: t.schema },
  ) as StructuredToolInterface;
}

/** Wrap a turn's toolset with the session cache. Names, descriptions and
 *  schemas pass through untouched, so the cacheable prompt prefix and the
 *  byte-stable tool ordering both stay exactly as they were. */
export function withSessionResultCache(
  tools: StructuredToolInterface[],
  sessionId: string | null | undefined,
): StructuredToolInterface[] {
  if (!sessionId) return tools; // test panel / no durable session — no caching
  return tools.map(t => wrap(t, sessionId));
}

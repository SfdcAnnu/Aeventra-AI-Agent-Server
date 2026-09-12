/**
 * tool-replay — how a PERSISTED tool result is rendered back into a later
 * turn's context.
 *
 * Salesforce is the system of record for chat history, so every turn
 * rebuilds its context from ChatMessage__c rows rather than from live
 * message state. That makes THIS file the thing that decides what the
 * model still knows about work it already did.
 *
 * Live-diagnosed failure this replaces: on one conversation, every tool
 * result was clipped to a flat 600 characters and folded into the
 * assistant's own prose. A 9,244-character object schema came back as its
 * first few fields, so the next turn re-read the artifact, re-described the
 * object, pulled the full 1,315-object index, and finally guessed — four
 * tool calls and ~15k input tokens to recover data it already had. Two
 * Opportunity queries three turns apart were byte-identical.
 *
 * Three rules follow from that:
 *
 *  1. DECODE. Apex stores Content__c as JSON.serialize(<string>), so
 *     results arrive double-encoded. Replaying the escaped form spends
 *     real tokens on backslashes and reads worse.
 *  2. BUDGET BY RECENCY, NOT A FLAT CAP. Recent results — the ones a turn
 *     is most likely to still need — survive intact; older ones shrink; a
 *     global cap keeps a long conversation from growing its own context
 *     without bound.
 *  3. NEVER CLIP AN ARTIFACT HANDLE. An artifact reference is compact by
 *     construction and is the one thing that lets a later turn fetch the
 *     real data back (artifact-store.ts) instead of re-running the tool.
 */

const envInt = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** How many of the most recent tool results keep the generous budget. */
const RECENT_COUNT = envInt('TOOL_REPLAY_RECENT_COUNT', 8);
const RECENT_CHARS = envInt('TOOL_REPLAY_RECENT_CHARS', 3_000);
const OLDER_CHARS = envInt('TOOL_REPLAY_OLDER_CHARS', 500);
/** Ceiling across ALL replayed tool results in one turn. */
const TOTAL_CHARS = envInt('TOOL_REPLAY_TOTAL_CHARS', 24_000);

export interface ToolHistoryRow {
  content: string;
  toolCallsJson?: string | null;
  toolResultsJson?: string | null;
  toolCallId?: string | null;
}

export interface ParsedToolRow {
  /** The provider's original tool_call id, when it survived persistence.
   *  Without it the result can only be replayed as prose — see
   *  graph-runtime's toLangchainMessages. */
  id: string | null;
  name: string;
  args: Record<string, unknown>;
  /** Decoded result text; budgeted in place by budgetToolReplays. */
  result: string;
}

/** Apex persists Content__c as JSON.serialize(<string>), so a stored result
 *  arrives double-encoded: "{\"records\":[…]}". Unwrap one layer. */
export function decodeStoredResult(raw: string): string {
  const t = raw.trim();
  if (!t.startsWith('"')) return raw;
  try {
    const parsed = JSON.parse(t) as unknown;
    return typeof parsed === 'string' ? parsed : raw;
  } catch {
    return raw;
  }
}

/** The artifact id when a stored result is an artifact REFERENCE (produced
 *  by artifact-store.ts's spillIfLarge), else null. */
export function artifactIdOf(result: string): string | null {
  const t = result.trim();
  if (!t.startsWith('{') || !t.includes('"artifact"')) return null;
  try {
    const j = JSON.parse(t) as { artifact?: unknown };
    return typeof j.artifact === 'string' && j.artifact ? j.artifact : null;
  } catch {
    return null;
  }
}

function clip(text: string, budget: number): string {
  if (text.length <= budget) return text;
  // Keep the HEAD: record ids and field names lead a Salesforce payload.
  return `${text.slice(0, budget)}…[truncated — ${text.length} chars in the full result]`;
}

/** Assign each tool result its replay budget, newest first, under one
 *  global cap. Input is in conversation order; output is index-aligned. */
export function budgetToolReplays(results: string[]): string[] {
  const out = new Array<string>(results.length);
  let pool = TOTAL_CHARS;
  for (let i = results.length - 1; i >= 0; i--) {
    const text = results[i];
    // Artifact references bypass the budget: tiny, and clipping one would
    // destroy the handle that makes re-fetching cheap.
    if (artifactIdOf(text)) {
      out[i] = text;
      continue;
    }
    const fromEnd = results.length - 1 - i;
    const want = fromEnd < RECENT_COUNT ? RECENT_CHARS : OLDER_CHARS;
    const budget = Math.max(0, Math.min(want, pool));
    out[i] = budget > 0
      ? clip(text, budget)
      : '[older tool result dropped to stay within the context budget — re-run the tool if you still need it]';
    pool -= Math.min(text.length, budget);
  }
  return out;
}

/** Read one persisted tool row into its call/result parts. Returns null for
 *  a row with no usable output (nothing to replay). */
export function parseToolRow(m: ToolHistoryRow): ParsedToolRow | null {
  let name = 'tool';
  let args: Record<string, unknown> = {};
  let id: string | null = null;
  try {
    const j = JSON.parse(m.toolCallsJson ?? '{}') as { name?: unknown; args?: unknown; id?: unknown };
    if (typeof j.name === 'string' && j.name) name = j.name;
    if (j.args && typeof j.args === 'object' && !Array.isArray(j.args)) args = j.args as Record<string, unknown>;
    if (typeof j.id === 'string' && j.id.trim()) id = j.id.trim();
  } catch { /* defaults are fine — an unparseable row still replays as prose */ }
  if (!id && typeof m.toolCallId === 'string' && m.toolCallId.trim()) id = m.toolCallId.trim();

  const raw = (m.content ?? '').trim() || (m.toolResultsJson ?? '').trim();
  if (!raw) return null;
  return { id, name, args, result: decodeStoredResult(raw) };
}

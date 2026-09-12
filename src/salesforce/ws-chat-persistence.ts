/**
 * Persists WebSocket-path chat turns back to Salesforce (ChatSession__c /
 * ChatMessage__c) — the counterpart to AgentChatController.cls's own
 * startSession()/sendTurn() DML for the HTTP chat path.
 *
 * Why this exists: AgentGuardrailsController.cls's usage totals are
 * computed by SUMMING ChatMessage__c.TokensIn__c/TokensOut__c (see
 * guardrails.ts). If WebSocket turns never wrote any ChatMessage__c rows,
 * their real token spend would be permanently invisible to that sum —
 * the cap could never actually account for React-app usage, regardless of
 * how the pre-turn check in guardrails.ts is wired up. Writing real rows
 * here is what makes the guardrail's accounting complete, not just its
 * enforcement — as a side benefit these sessions also show up in the
 * existing Conversations list (agentHome), same as any other chat.
 *
 * A ChatSession__c is resolved once per WebSocket connection (not per
 * message) via resolveWsChatSession() below — either reusing a real,
 * pre-existing session (the full-parity chat panel always mints its
 * ticket against a real session obtained via startSession/getSession over
 * REST first) or creating a fresh one (ChatTestPanel's throwaway
 * sessions, which never match a real record) — and reused for every turn
 * on that connection, mirrored by the caller (ws/gateway.ts) holding the
 * returned id in its own per-connection state.
 */
import type { Connection } from 'jsforce';
import type { ChatTurnResult, ModelUsage } from '../chat/adapters/types';

const EXPIRY_HOURS = 24; // matches AgentChatController.EXPIRY_HOURS

export async function createWsChatSession(
  conn: Connection,
  agentId: string,
  userId: string,
  department: string | undefined,
): Promise<string> {
  const now = new Date();
  const expires = new Date(now.getTime() + EXPIRY_HOURS * 60 * 60 * 1000);
  const result = await conn.sobject('ChatSession__c').create({
    AgentDefinition__c: agentId,
    User__c: userId,
    Status__c: 'Active',
    LastActivityAt__c: now.toISOString(),
    ExpiresAt__c: expires.toISOString(),
    Department__c: department ?? null,
    TotalTurns__c: 0,
  });
  if (!result.success) {
    throw new Error('Failed to create ChatSession__c for WS turn: ' + JSON.stringify(result));
  }
  return result.id;
}

/** Salesforce Id shape check — cheap way to tell "a real ChatSession__c Id
 *  was passed at ticket-mint time" apart from an opaque client-generated
 *  string (e.g. ChatTestPanel's `ui-bundle-test-<timestamp>`), without a
 *  wasted query for the common test-panel case. */
function looksLikeSalesforceId(value: string): boolean {
  return /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(value);
}

/** Resolves the ChatSession__c a WS connection's turns should write to —
 *  reuses an existing session when the ticket's sessionId is a real,
 *  accessible ChatSession__c (the full-parity chat panel always mints its
 *  ticket with a real session Id obtained via startSession/getSession over
 *  REST first), otherwise creates a fresh one exactly as before (preserves
 *  ChatTestPanel's existing throwaway-session behavior unchanged, since its
 *  client-generated id never matches a real record). */
export async function resolveWsChatSession(
  conn: Connection,
  candidateSessionId: string,
  agentId: string,
  userId: string,
  department: string | undefined,
): Promise<{ chatSessionId: string; nextSeq: number }> {
  if (looksLikeSalesforceId(candidateSessionId)) {
    const existing = await conn.query<{ Id: string }>(
      `SELECT Id FROM ChatSession__c WHERE Id = '${candidateSessionId}' AND AgentDefinition__c = '${agentId}' LIMIT 1`,
    );
    if (existing.records.length > 0) {
      const lastSeq = await conn.query<{ SequenceNumber__c: number }>(
        `SELECT SequenceNumber__c FROM ChatMessage__c WHERE ChatSession__c = '${candidateSessionId}' ORDER BY SequenceNumber__c DESC LIMIT 1`,
      );
      const nextSeq = (lastSeq.records[0]?.SequenceNumber__c ?? 0) + 1;
      return { chatSessionId: candidateSessionId, nextSeq };
    }
  }
  const chatSessionId = await createWsChatSession(conn, agentId, userId, department);
  return { chatSessionId, nextSeq: 1 };
}

/** First-message title, matching AgentChatController's own fallback
 *  (117 chars then an ellipsis) so both paths name sessions identically. */
function titleFrom(userText: string): string | null {
  const t = (userText ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return null;
  return t.length > 117 ? t.slice(0, 117) + '...' : t;
}

/** Running per-model totals, merged the same way AgentChatController does
 *  for the HTTP path, so both paths produce one comparable shape. */
function mergeUsageByModel(existingJson: string | null | undefined, usage: ModelUsage[] | undefined): string | null {
  if (!usage || usage.length === 0) return existingJson ?? null;
  const byModel = new Map<string, { model: string; calls: number; tokensIn: number; tokensOut: number; cacheRead: number }>();
  if (existingJson) {
    try {
      for (const row of JSON.parse(existingJson) as Array<{ model?: string }>) {
        if (row?.model) byModel.set(row.model, row as never);
      }
    } catch {
      byModel.clear(); // a corrupt blob must not cost this turn's accounting
    }
  }
  for (const u of usage) {
    const key = u.model || 'unknown';
    const acc = byModel.get(key) ?? { model: key, calls: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0 };
    acc.calls += u.calls ?? 0;
    acc.tokensIn += u.tokensIn ?? 0;
    acc.tokensOut += u.tokensOut ?? 0;
    acc.cacheRead += u.cacheRead ?? 0;
    byModel.set(key, acc);
  }
  return JSON.stringify([...byModel.values()]).slice(0, 32_768);
}

/**
 * Write one completed WS turn and roll the session's totals forward.
 *
 * The rollup is the part that used to be missing: messages were written
 * with their token counts, but ChatSession__c only had its activity
 * timestamps touched. Conversations reads the SESSION counters, so a
 * websocket chat showed "0 in / 0 out" and "0 messages" next to a
 * transcript that plainly had both.
 *
 * Tool results are written too, with their provider tool_call id, so a
 * websocket conversation replays as real tool-call/tool-result pairs on
 * later turns exactly like the HTTP path (see chat/tool-replay.ts).
 *
 * @returns how many rows were written, so the caller can advance its
 *          sequence counter past them.
 */
export async function recordWsTurn(
  conn: Connection,
  sessionId: string,
  seqStart: number,
  userText: string,
  result: ChatTurnResult,
): Promise<number> {
  const rows: Array<Record<string, unknown>> = [
    {
      ChatSession__c: sessionId,
      Role__c: 'User',
      Content__c: userText,
      SequenceNumber__c: seqStart,
      ApprovalStatus__c: 'NotRequired',
    },
  ];

  let seq = seqStart + 1;
  for (const call of result.toolCalls ?? []) {
    const output = typeof call.output === 'string' ? call.output : JSON.stringify(call.output ?? '');
    rows.push({
      ChatSession__c: sessionId,
      Role__c: 'Tool',
      Content__c: JSON.stringify(output).slice(0, 131_072),
      ToolCallsJson__c: JSON.stringify({ id: call.id, name: call.name, args: call.input }).slice(0, 32_768),
      ToolResultsJson__c: JSON.stringify(call).slice(0, 32_768),
      SequenceNumber__c: seq++,
      ApprovalStatus__c: 'NotRequired',
    });
  }

  const cachedTokens = (result.usage ?? []).reduce((n, u) => n + (u.cacheRead ?? 0), 0);
  rows.push({
    ChatSession__c: sessionId,
    Role__c: 'Assistant',
    Content__c: result.assistantText,
    ModelUsed__c: result.modelUsed ?? null,
    TokensIn__c: result.tokensIn,
    TokensOut__c: result.tokensOut,
    CachedTokens__c: cachedTokens,
    LatencyMs__c: result.latencyMs ?? null,
    UsageJson__c: result.usage ? JSON.stringify(result.usage).slice(0, 32_768) : null,
    SequenceNumber__c: seq++,
    ApprovalStatus__c: 'NotRequired',
  });

  await conn.sobject('ChatMessage__c').create(rows);

  // Read-then-increment: these are per-session counters with a single
  // writer (one websocket connection), so a read-modify-write is safe and
  // keeps the HTTP and WS paths producing identical session totals.
  const current = await conn.query<{
    Title__c: string | null;
    TotalTurns__c: number | null;
    TokensIn__c: number | null;
    TokensOut__c: number | null;
    CachedTokens__c: number | null;
    LatencyMsTotal__c: number | null;
    UsageByModelJson__c: string | null;
  }>(
    `SELECT Title__c, TotalTurns__c, TokensIn__c, TokensOut__c, CachedTokens__c, LatencyMsTotal__c, UsageByModelJson__c
       FROM ChatSession__c WHERE Id = '${sessionId}' LIMIT 1`,
  );
  const prev = current.records[0];
  const now = new Date();
  await conn.sobject('ChatSession__c').update({
    Id: sessionId,
    LastActivityAt__c: now.toISOString(),
    ExpiresAt__c: new Date(now.getTime() + EXPIRY_HOURS * 60 * 60 * 1000).toISOString(),
    // Same first-message fallback the HTTP path applies, so a websocket
    // conversation is identifiable in the list from its very first turn
    // rather than reading as a bare CHAT-#### until the AI titler runs.
    ...(prev && !prev.Title__c ? { Title__c: titleFrom(userText) } : {}),
    TotalTurns__c: (prev?.TotalTurns__c ?? 0) + 1,
    TokensIn__c: (prev?.TokensIn__c ?? 0) + (result.tokensIn ?? 0),
    TokensOut__c: (prev?.TokensOut__c ?? 0) + (result.tokensOut ?? 0),
    CachedTokens__c: (prev?.CachedTokens__c ?? 0) + cachedTokens,
    LatencyMsTotal__c: (prev?.LatencyMsTotal__c ?? 0) + (result.latencyMs ?? 0),
    UsageByModelJson__c: mergeUsageByModel(prev?.UsageByModelJson__c, result.usage),
  });

  return rows.length;
}

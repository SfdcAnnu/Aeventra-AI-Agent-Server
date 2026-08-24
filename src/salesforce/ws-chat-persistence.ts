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

export async function recordWsTurn(
  conn: Connection,
  sessionId: string,
  seqStart: number,
  userText: string,
  assistantText: string,
  modelUsed: string | undefined,
  tokensIn: number,
  tokensOut: number,
): Promise<void> {
  await conn.sobject('ChatMessage__c').create([
    {
      ChatSession__c: sessionId,
      Role__c: 'User',
      Content__c: userText,
      SequenceNumber__c: seqStart,
      ApprovalStatus__c: 'NotRequired',
    },
    {
      ChatSession__c: sessionId,
      Role__c: 'Assistant',
      Content__c: assistantText,
      ModelUsed__c: modelUsed ?? null,
      TokensIn__c: tokensIn,
      TokensOut__c: tokensOut,
      SequenceNumber__c: seqStart + 1,
      ApprovalStatus__c: 'NotRequired',
    },
  ]);
  await conn.sobject('ChatSession__c').update({
    Id: sessionId,
    LastActivityAt__c: new Date().toISOString(),
    ExpiresAt__c: new Date(Date.now() + EXPIRY_HOURS * 60 * 60 * 1000).toISOString(),
  });
}

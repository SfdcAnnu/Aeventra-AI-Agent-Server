/**
 * Org-wide chat token guardrail — the WebSocket-path counterpart to
 * AgentGuardrailsController.cls's enforceBeforeTurn()/computeUsage().
 *
 * Why this exists in Node too: AgentChatController.cls's HTTP chat path
 * calls enforceBeforeTurn() before every turn, but a WebSocket turn never
 * routes through Apex (only ticket-mint does — see ws/gateway.ts's module
 * doc). Without a check here, the cap would silently not apply to any
 * chat started from the React app. This mirrors the Apex logic exactly;
 * keep the two in sync if either changes.
 */
import type { Connection } from 'jsforce';

export interface GuardrailCheckResult {
  blocked: boolean;
  message?: string;
}

interface GuardrailsRow {
  IsEnabled__c: boolean;
  MaxTokensPerDay__c: number | null;
  MaxTokensPerMonth__c: number | null;
}

interface TokenSumRow {
  tIn: number | null;
  tOut: number | null;
}

/**
 * The settings row, briefly cached.
 *
 * This runs on EVERY turn, before the model is allowed to start, and for
 * an org with the cap switched off it is the only thing this function
 * does — one Salesforce round trip bought to learn "no" over and over.
 *
 * ONLY THE SETTINGS ARE CACHED, never a decision and never the totals. An
 * org with the cap ON still sums its usage fresh on every turn, because a
 * spend cap that is checked against a minute-old number is not a spend
 * cap. What this delays is noticing that an admin CHANGED the setting,
 * which is worth at most a minute.
 */
const SETTINGS_TTL_MS = 60_000;
const settingsCache = new Map<string, { row: GuardrailsRow | undefined; at: number }>();

export async function checkGuardrails(conn: Connection, orgId: string): Promise<GuardrailCheckResult> {
  let row: GuardrailsRow | undefined;
  const hit = settingsCache.get(orgId);
  if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) {
    row = hit.row;
  } else {
    const rows = await conn.query<GuardrailsRow>(
      `SELECT IsEnabled__c, MaxTokensPerDay__c, MaxTokensPerMonth__c FROM AgentGuardrails__c WHERE SetupOwnerId = '${orgId}' LIMIT 1`,
    );
    row = rows.records[0];
    settingsCache.set(orgId, { row, at: Date.now() });
  }
  if (!row || row.IsEnabled__c !== true) return { blocked: false };

  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [today, month] = await Promise.all([
    sumTokensSince(conn, startOfDay),
    sumTokensSince(conn, startOfMonth),
  ]);

  if (row.MaxTokensPerDay__c != null && today >= row.MaxTokensPerDay__c) {
    return {
      blocked: true,
      message: `Daily AI usage guardrail reached (${Math.floor(today)} / ${Math.floor(row.MaxTokensPerDay__c)} tokens used today across all agents). Contact your admin, or try again tomorrow.`,
    };
  }
  if (row.MaxTokensPerMonth__c != null && month >= row.MaxTokensPerMonth__c) {
    return {
      blocked: true,
      message: `Monthly AI usage guardrail reached (${Math.floor(month)} / ${Math.floor(row.MaxTokensPerMonth__c)} tokens used this month across all agents). Contact your admin.`,
    };
  }
  return { blocked: false };
}

async function sumTokensSince(conn: Connection, since: Date): Promise<number> {
  // SOQL datetime literals are unquoted ISO-8601.
  const literal = since.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const result = await conn.query<TokenSumRow>(
    `SELECT SUM(TokensIn__c) tIn, SUM(TokensOut__c) tOut FROM ChatMessage__c WHERE Role__c = 'Assistant' AND CreatedDate >= ${literal}`,
  );
  const row = result.records[0];
  return (row?.tIn ?? 0) + (row?.tOut ?? 0);
}

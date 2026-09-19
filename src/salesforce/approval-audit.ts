/**
 * approval-audit — the decision on a chat approval, written into the
 * conversation it belongs to.
 *
 * The approval itself lives in this server's database (ChatApproval: who
 * asked, what tool, what arguments, who decided, when). Salesforce holds
 * the transcript, and an auditor reads the transcript. So every decision
 * also lands as a System message under the ChatSession__c, right after
 * the turn that asked: who approved or rejected, which action, with which
 * arguments, when, and how the execution went. ApprovalStatus__c and
 * ApprovedAt__c on that row are what reports filter on.
 *
 * Never fails a decision: the approval's own record is the source of
 * truth, and a write here that cannot land is logged, not thrown.
 */
import type { Connection } from 'jsforce';
import type { ChatApproval } from '@prisma/client';
import { getOrgConnection } from './per-org-connection';
import { logger } from '../logger';

const NAME_TTL_MS = 10 * 60 * 1000;
const names = new Map<string, { name: string; at: number }>();

/** A user's display name, cached — the audit line names a person, not an id. */
export async function userDisplayName(conn: Connection, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const hit = names.get(userId);
  if (hit && Date.now() - hit.at < NAME_TTL_MS) return hit.name;
  try {
    const r = await conn.query<{ Name: string }>(`SELECT Name FROM User WHERE Id = '${userId.replace(/[^A-Za-z0-9]/g, '')}' LIMIT 1`);
    const name = r.records[0]?.Name ?? null;
    if (name) names.set(userId, { name, at: Date.now() });
    return name;
  } catch {
    return null;
  }
}

/** Names for a set of user ids, for listings that carry decidedBy. */
export async function userDisplayNames(orgId: string, ids: Array<string | null | undefined>): Promise<Record<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return {};
  const out: Record<string, string> = {};
  try {
    const conn = await getOrgConnection(orgId);
    for (const id of wanted) { const n = await userDisplayName(conn, id); if (n) out[id] = n; }
  } catch { /* names are a nicety; ids still identify */ }
  return out;
}

const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n)} …` : s) : '');

function argsSummary(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const entries = Object.entries(args as Record<string, unknown>).slice(0, 6)
    .map(([k, v]) => `${k}=${clip(typeof v === 'string' ? v : JSON.stringify(v), 60)}`);
  return entries.join(', ');
}

export async function recordApprovalDecision(
  row: ChatApproval,
  decision: 'approved' | 'rejected',
  deciderUserId: string | null | undefined,
  outcome: { status: string; resultText?: string | null },
): Promise<void> {
  try {
    const conn = await getOrgConnection(row.orgId);
    const name = (await userDisplayName(conn, deciderUserId)) ?? deciderUserId ?? 'an unknown user';
    const last = await conn.query<{ SequenceNumber__c: number }>(
      `SELECT SequenceNumber__c FROM ChatMessage__c WHERE ChatSession__c = '${row.sessionId.replace(/[^A-Za-z0-9]/g, '')}' ORDER BY SequenceNumber__c DESC LIMIT 1`,
    );
    const seq = (last.records[0]?.SequenceNumber__c ?? 0) + 1;
    const at = new Date();
    const verb = decision === 'approved' ? 'Approved' : 'Rejected';
    const content = `${verb} by ${name} · ${row.toolName}(${argsSummary(row.argsJson)}) → ${outcome.status}` +
      (outcome.resultText ? ` — ${clip(outcome.resultText, 400)}` : '');
    const audit = {
      approvalId: row.id,
      toolName: row.toolName,
      args: row.argsJson,
      requestedAt: row.createdAt,
      requestedBy: row.userId,
      decision,
      decidedBy: deciderUserId ?? null,
      decidedByName: name,
      decidedAt: at.toISOString(),
      status: outcome.status,
      resultText: clip(outcome.resultText, 2000) || null,
    };
    await conn.sobject('ChatMessage__c').create({
      ChatSession__c: row.sessionId,
      Role__c: 'System',
      Content__c: content.slice(0, 131_072),
      SequenceNumber__c: seq,
      RequiredApproval__c: true,
      ApprovalStatus__c: decision === 'approved' ? 'Approved' : 'Declined',
      ApprovedAt__c: at.toISOString(),
      ToolCallsJson__c: JSON.stringify(audit).slice(0, 32_768),
    });
    logger.info({ orgId: row.orgId, sessionId: row.sessionId, approvalId: row.id, decision, by: deciderUserId ?? null }, 'chat_approval_audited');
  } catch (err) {
    logger.warn({ orgId: row.orgId, approvalId: row.id, err: err instanceof Error ? err.message : String(err) }, 'chat_approval_audit_failed');
  }
}

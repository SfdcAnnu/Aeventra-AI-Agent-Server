/**
 * BACKGROUND TOOLS: THE REPLY DOES NOT WAIT FOR THE WRITE.
 *
 * Every tool call used to block the turn: the model asked for
 * updateSobjectRecord, the runtime ran it against Salesforce, the result
 * went back to the model, and only then was the reply written. Measured
 * on the WhatsApp intake agent: a write turn was ~3.7 s of which the
 * write itself was ~0.7 s and the second model call — there only to
 * phrase a reply whose content the model already knew — ~1.5 s.
 *
 * A tool marked "run in the background" (a tool node's runInBackground, or
 * a catalog node's backgroundTools list) is not executed inline. The call
 * is queued -- per session, in order, durable in Postgres -- and answers
 * the model at once with {queued: true}. A worker runs it right after and
 * records the outcome. When every tool call in a model step is a
 * background one and the step carries reply text, the turn ends with that
 * text (graph-runtime.ts) and the customer reads it ~2 s sooner.
 *
 * Truth is kept three ways. The next turn waits for this session's
 * pending writes before it reads the record, but only while they are
 * young: a write that has already run for longer than the hold belongs
 * to a slow org (a trigger chain with callouts), waiting more would not
 * help, and the turn goes ahead with a "still running" line in its
 * prompt instead. Every outcome finished since the last reply is put in
 * front of the model as "Background results", so a failed write is
 * corrected in the next reply. And a failure leaves a follow-up Task on
 * the record and a System line in the conversation, so a person sees it
 * even when the customer never writes again.
 *
 * A timeout is not a failure. The MCP client gives a call 60 s; a slow
 * org can take longer and still commit. Such a job is recorded as
 * unconfirmed, the Task says "could not confirm", and the model is told
 * to read the record before it says whether the write saved.
 *
 * Never background: reads (the reply depends on them) and approval-gated
 * writes (a person decides first).
 */
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AIMessage } from '@langchain/core/messages';
import { prisma } from '../db/client';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { pkgConn } from '../salesforce/namespace';
import { logger } from '../logger';
import type { AgentDefinition } from '../types';

export interface BackgroundMeta {
  orgId: string;
  sessionId: string;
  agentApiName: string;
  recordContextId?: string | null;
  recordContextType?: string | null;
}

/** Tool names the agent's nodes mark as background: a tool node's
 *  `runInBackground`, or a catalog node's `backgroundTools`. A tool that
 *  also requires approval is never background -- the gate wins. */
export function backgroundToolNames(agent: AgentDefinition): Set<string> {
  const names = new Set<string>();
  for (const n of agent.nodes) {
    if (n.isEnabled === false) continue;
    const cfg = (n.config ?? {}) as { runInBackground?: unknown; requiresApproval?: unknown; toolName?: unknown; backgroundTools?: unknown };
    if (n.nodeType === 'tool' && cfg.runInBackground === true && cfg.requiresApproval !== true && typeof cfg.toolName === 'string' && cfg.toolName) {
      names.add(cfg.toolName);
    }
    if (n.nodeType === 'catalog' && Array.isArray(cfg.backgroundTools)) {
      for (const t of cfg.backgroundTools) if (typeof t === 'string' && t) names.add(t);
    }
  }
  return names;
}

// ── The queue: one chain per session, durable rows ────────────────────
const chains = new Map<string, Promise<void>>();
const RESULT_CHARS = 2_000;
/** How long the next turn will wait for a young write (see awaitPendingBackground). */
export const HOLD_MS = Number(process.env.BACKGROUND_HOLD_MS) || 8_000;
// Sessions with an outcome not yet shown. Reading the table on every turn
// cost ~240 ms of buildPrompt (a Postgres round trip from Render) even
// when nothing had been queued; a session is read once after boot, then
// only when a job of its own has finished.
const unreported = new Set<string>();
const readOnce = new Set<string>();

/** What is queued or running right now, per session, oldest first. In
 *  memory only: the hold rule and the "still running" lines read it, so a
 *  turn never pays a Postgres round trip to learn that nothing is pending. */
interface PendingJob { id: string; tool: string; args: unknown; queuedAt: number; startedAt: number | null }
const pending = new Map<string, PendingJob[]>();
const pendingOf = (sessionId: string): PendingJob[] => pending.get(sessionId) ?? [];
function forgetPending(sessionId: string, id: string): void {
  const list = pending.get(sessionId);
  if (!list) return;
  const i = list.findIndex(j => j.id === id);
  if (i >= 0) list.splice(i, 1);
  if (list.length === 0) pending.delete(sessionId);
}

interface Enqueued { id: string; queuedAt: Date }

async function enqueue(meta: BackgroundMeta, t: StructuredToolInterface, args: unknown): Promise<Enqueued> {
  const row = await prisma.backgroundToolRun.create({
    data: {
      orgId: meta.orgId,
      sessionId: meta.sessionId,
      agentApiName: meta.agentApiName,
      recordContextId: meta.recordContextId ?? null,
      recordContextType: meta.recordContextType ?? null,
      tool: t.name,
      args: (args ?? {}) as object,
      status: 'queued',
    },
  });
  (pending.get(meta.sessionId) ?? pending.set(meta.sessionId, []).get(meta.sessionId)!).push({ id: row.id, tool: t.name, args, queuedAt: Date.now(), startedAt: null });
  const prev = chains.get(meta.sessionId) ?? Promise.resolve();
  const next = prev
    .catch(() => { /* a failed job never blocks the next */ })
    .then(() => runJob(row.id, meta, t, args));
  chains.set(meta.sessionId, next);
  void next.finally(() => { if (chains.get(meta.sessionId) === next) chains.delete(meta.sessionId); });
  return { id: row.id, queuedAt: row.queuedAt };
}

/** The MCP client's own limit on one call, and what its error looks like. */
const TIMEOUT_RE = /timed out|timeout/i;

async function runJob(id: string, meta: BackgroundMeta, t: StructuredToolInterface, args: unknown): Promise<void> {
  const startedAt = new Date();
  const job = pendingOf(meta.sessionId).find(j => j.id === id);
  if (job) job.startedAt = startedAt.getTime();
  await prisma.backgroundToolRun.update({ where: { id }, data: { status: 'running', startedAt } }).catch(() => { /* best effort */ });
  try {
    const raw = await t.invoke(args as never);
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    // The tool's own answer says whether Salesforce accepted the write:
    // the CRM server returns {success:false, message} on a rejected value.
    const failedInside = /"success"\s*:\s*false|^(PENDING_APPROVAL|REJECTED|BLOCKED|Error|ERROR)\b/.test(text);
    await prisma.backgroundToolRun.update({
      where: { id },
      data: { status: failedInside ? 'failed' : 'done', result: text.slice(0, RESULT_CHARS), error: failedInside ? text.slice(0, 500) : null, finishedAt: new Date(), ms: Date.now() - startedAt.getTime() },
    });
    unreported.add(meta.sessionId);
    logger.info({ orgId: meta.orgId, sessionId: meta.sessionId, tool: t.name, ms: Date.now() - startedAt.getTime(), failed: failedInside }, 'background_tool_done');
    if (failedInside) await leaveFollowUpTask(meta, t.name, text.slice(0, 500), args, 'failed');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A call that timed out may well have completed on the Salesforce side
    // -- a slow org's trigger chain outlives the client's 60 s -- so it is
    // recorded as unconfirmed, never as failed.
    const kind: Outcome = TIMEOUT_RE.test(message) ? 'unconfirmed' : 'failed';
    const error = kind === 'unconfirmed'
      ? `Timed out after ${Math.round((Date.now() - startedAt.getTime()) / 1000)} s; Salesforce may still have completed it. (${message.slice(0, 300)})`
      : message.slice(0, 500);
    await prisma.backgroundToolRun.update({
      where: { id },
      data: { status: kind, error, finishedAt: new Date(), ms: Date.now() - startedAt.getTime() },
    }).catch(() => { /* best effort */ });
    unreported.add(meta.sessionId);
    logger.error({ orgId: meta.orgId, sessionId: meta.sessionId, tool: t.name, kind, err: message }, 'background_tool_failed');
    await leaveFollowUpTask(meta, t.name, error, args, kind);
  } finally {
    forgetPending(meta.sessionId, id);
  }
}

type Outcome = 'failed' | 'unconfirmed';

/** A write that failed after the customer was told it was done leaves a
 *  Task on the record so a person sees it even if the customer goes quiet,
 *  and a System line in the conversation so the transcript says why. */
async function leaveFollowUpTask(meta: BackgroundMeta, toolName: string, error: string, args: unknown, kind: Outcome): Promise<void> {
  const subject = kind === 'unconfirmed' ? `Agent action could not be confirmed: ${toolName}` : `Agent action failed: ${toolName}`;
  const said = kind === 'unconfirmed'
    ? `The ${meta.agentApiName} agent told the customer this was done; the call timed out and Salesforce may or may not have completed it. Please check the record.`
    : `The ${meta.agentApiName} agent told the customer this was done, but it failed afterwards.`;
  try {
    const conn = await getOrgConnection(meta.orgId);
    const isPerson = meta.recordContextType === 'Lead' || meta.recordContextType === 'Contact';
    await conn.sobject('Task').create({
      Subject: subject,
      Description: `${said}\nSession: ${meta.sessionId}\n\nError: ${error}\n\nArguments: ${JSON.stringify(args).slice(0, 1500)}`,
      Status: 'Not Started',
      Priority: 'High',
      ActivityDate: new Date().toISOString().slice(0, 10),
      // No anchored record (a web-chat session): the Task still exists, on
      // the running user, with the session named so a person can find it.
      ...(meta.recordContextId
        ? (isPerson ? { WhoId: meta.recordContextId } : { WhatId: meta.recordContextId })
        : createdAnchor.has(meta.sessionId) ? { WhoId: createdAnchor.get(meta.sessionId) } : {}),
    });
  } catch (err) {
    logger.warn({ orgId: meta.orgId, err: err instanceof Error ? err.message : String(err) }, 'background_follow_up_task_failed');
  }
  await leaveConversationNote(meta, `${subject}${describeArgs(args)} — ${error.slice(0, 300)}. A Task was left on the record.`);
}

/** One System row in the conversation's transcript: visible on the
 *  Conversations page whether or not the customer ever writes again. The
 *  chat UI keeps System rows out of the model's history, so this is for
 *  people; the model learns the outcome from the results block. */
async function leaveConversationNote(meta: BackgroundMeta, text: string): Promise<void> {
  const sid = meta.sessionId.replace(/[^A-Za-z0-9]/g, '');
  if (!sid) return;
  try {
    const pc = pkgConn(await getOrgConnection(meta.orgId));
    const last = await pc.query<{ SequenceNumber__c: number }>(
      `SELECT SequenceNumber__c FROM ChatMessage__c WHERE ChatSession__c = '${sid}' ORDER BY SequenceNumber__c DESC LIMIT 1`,
    );
    const seq = (last.records[0]?.SequenceNumber__c ?? 0) + 1;
    await pc.sobject('ChatMessage__c').create({
      ChatSession__c: meta.sessionId,
      Role__c: 'System',
      Content__c: text.slice(0, 2_000),
      SequenceNumber__c: seq,
    });
  } catch (err) {
    logger.warn({ orgId: meta.orgId, sessionId: meta.sessionId, err: err instanceof Error ? err.message : String(err) }, 'background_conversation_note_failed');
  }
}

/** Wrap a tool so a call queues instead of running. The answer the model
 *  reads says so plainly; the prompt line tells it what that means. */
const CREATE_RE = /create|insert|upsert/i;

/**
 * A create the conversation has no record for yet runs INLINE: its Id is
 * the handle every later write needs. Measured: with the Lead's create
 * queued, the model had no Id for the email update, wrote "use-latest"
 * into every update and every one failed while the customer was told
 * they were saved. Once the session is anchored to a record, creates of
 * other records (an Event, a Task on the Lead) go to the background.
 */
// The record a web-chat conversation created for itself. The session row
// carries no anchor on that path, so the first successful inline create
// is remembered here: from then on the conversation HAS a record, and the
// Event and Task it creates later go to the background like any write.
const createdAnchor = new Map<string, string>();
const SF_ID_RE = /"(?:id|Id)"\s*:\s*"([a-zA-Z0-9]{15,18})"/;

export function mustRunInline(toolName: string, meta: BackgroundMeta): boolean {
  return CREATE_RE.test(toolName) && !meta.recordContextId && !createdAnchor.has(meta.sessionId);
}

/** For tests. */
export function _forgetCreatedAnchors(): void { createdAnchor.clear(); }

export function backgroundGate(meta: BackgroundMeta): (t: StructuredToolInterface) => StructuredToolInterface {
  return (t: StructuredToolInterface) =>
    tool(
      async (args: unknown) => {
        if (mustRunInline(t.name, meta)) {
          const raw = await t.invoke(args as never);
          const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
          const m = SF_ID_RE.exec(text);
          if (m && !/"success"\s*:\s*false/.test(text)) createdAnchor.set(meta.sessionId, m[1]);
          return text;
        }
        const { id } = await enqueue(meta, t, args);
        return JSON.stringify({ queued: true, job: id, note: 'This action runs in the background right after your reply. Treat it as done; a later "Background results" note reports the outcome.' });
      },
      { name: t.name, description: t.description, schema: t.schema },
    ) as StructuredToolInterface;
}

/**
 * Wait for this session's queued writes, so the next prompt reads the
 * record as written -- but only while they are young. A write on a normal
 * org lands in under a second, so a pending job that has already run for
 * the whole hold belongs to a slow org, and holding the turn longer would
 * only make the customer wait for nothing: the turn goes ahead and the
 * prompt says the write is still running (backgroundResultsBlock).
 */
export async function awaitPendingBackground(sessionId: string, holdMs = HOLD_MS): Promise<number> {
  const chain = chains.get(sessionId);
  if (!chain) return 0;
  const oldest = pendingOf(sessionId)[0];
  const age = oldest ? Date.now() - (oldest.startedAt ?? oldest.queuedAt) : 0;
  if (age >= holdMs) return 0;
  const t0 = Date.now();
  await Promise.race([chain.catch(() => undefined), new Promise(r => setTimeout(r, holdMs - age))]);
  return Date.now() - t0;
}

/**
 * What the model must know about this session's background writes: the
 * outcomes finished since they were last shown (marked shown, so a failure
 * is reported once, not on every turn) and whatever is still running.
 */
export async function backgroundResultsBlock(sessionId: string): Promise<string | null> {
  const now = Date.now();
  const running = pendingOf(sessionId).map(j =>
    `- ${j.tool}${describeArgs(j.args)} — STILL RUNNING, started ${Math.max(0, Math.round((now - (j.startedAt ?? j.queuedAt)) / 1000))} s ago. Say it is being processed; do not say it saved or failed.`,
  );
  const finished: string[] = [];
  if (unreported.has(sessionId) || !readOnce.has(sessionId)) {
    readOnce.add(sessionId);
    unreported.delete(sessionId);
    let rows: Array<{ id: string; tool: string; status: string; error: string | null; args: unknown; finishedAt: Date | null }> = [];
    try {
      rows = await prisma.backgroundToolRun.findMany({
        where: { sessionId, reportedAt: null, status: { in: ['done', 'failed', 'unconfirmed'] } },
        orderBy: { queuedAt: 'asc' },
        take: 20,
      });
    } catch (err) {
      logger.warn({ sessionId, err: err instanceof Error ? err.message : String(err) }, 'background_results_read_failed');
    }
    for (const r of rows) {
      const what = describeArgs(r.args);
      finished.push(
        r.status === 'failed' ? `- ${r.tool}${what} — FAILED: ${(r.error ?? 'unknown error').slice(0, 240)}`
          : r.status === 'unconfirmed' ? `- ${r.tool}${what} — UNCONFIRMED: ${(r.error ?? 'timed out').slice(0, 240)}`
            : `- ${r.tool}${what} — succeeded`,
      );
    }
    if (rows.length > 0) {
      void prisma.backgroundToolRun.updateMany({ where: { id: { in: rows.map(r => r.id) } }, data: { reportedAt: new Date() } }).catch(() => { /* best effort */ });
    }
  }
  if (finished.length === 0 && running.length === 0) return null;
  return (
    'BACKGROUND RESULTS since your last reply (actions you already told the customer were done):\n' +
    [...finished, ...running].join('\n') +
    '\nIf one FAILED, tell the customer plainly that it did not save and ask again for what it needed. ' +
    'If one is UNCONFIRMED, read the record before you say whether it saved. Never repeat a succeeded action.'
  );
}

function describeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  const obj = typeof a.sobjectType === 'string' ? a.sobjectType : typeof a.objectName === 'string' ? a.objectName : typeof a.sobject === 'string' ? a.sobject : null;
  const fields = a.fields && typeof a.fields === 'object' ? Object.keys(a.fields as object) : a.data && typeof a.data === 'object' ? Object.keys(a.data as object) : [];
  const parts = [obj, fields.length ? fields.slice(0, 6).join(', ') : null].filter(Boolean);
  return parts.length ? ` (${parts.join(': ')})` : '';
}

/** The prompt line an agent with background tools gets. */
export function backgroundPromptLine(names: Set<string>): string | null {
  if (names.size === 0) return null;
  return (
    `BACKGROUND TOOLS: ${[...names].sort().join(', ')}. They answer {queued:true} at once and run right after your reply. ` +
    'FORMAT RULE, every time a step calls only these tools: put the customer-facing reply in the CONTENT of the same assistant message that carries the tool calls -- ' +
    'text and tool calls together, one message. Never send a tool-call-only message and reply afterwards; that costs the customer an extra wait. ' +
    'Treat the action as done in that reply. A create that starts a new record (no record anchored yet) runs at once and returns its Id as usual -- use that Id in later writes. ' +
    'If a later "Background results" note says an action failed, tell the customer and ask again; if it says one is still running, say it is being processed.'
  );
}

/**
 * Speak, then act: a model step that carries reply text and only
 * background tool calls ends the turn -- the tools are queued, the text
 * goes out, and the second model call that used to phrase the reply is
 * not made.
 */
export function speaksThenActs(response: AIMessage, backgroundNames: Set<string>): boolean {
  const calls = response.tool_calls ?? [];
  if (calls.length === 0 || backgroundNames.size === 0) return false;
  if (!calls.every(c => backgroundNames.has(c.name))) return false;
  const text = typeof response.content === 'string'
    ? response.content
    : (response.content as Array<{ type?: string; text?: string }>).map(c => (c.type === 'text' ? c.text ?? '' : '')).join('');
  return text.trim().length > 0;
}

/** On boot: anything still queued or running belonged to a process that
 *  is gone. Mark it failed, and leave the same Task and conversation line
 *  a failure would, because the customer may never write again and a
 *  person must still find out. The next turn, if any, reports it too. */
export async function sweepOrphanedBackgroundRuns(): Promise<void> {
  const error = 'The server restarted before this action ran.';
  try {
    const rows = await prisma.backgroundToolRun.findMany({
      where: { status: { in: ['queued', 'running'] } },
      take: 200,
    });
    if (rows.length === 0) return;
    await prisma.backgroundToolRun.updateMany({
      where: { id: { in: rows.map(r => r.id) } },
      data: { status: 'failed', error, finishedAt: new Date() },
    });
    logger.warn({ count: rows.length }, 'background_runs_orphaned_by_restart');
    for (const r of rows) {
      await leaveFollowUpTask(
        { orgId: r.orgId, sessionId: r.sessionId, agentApiName: r.agentApiName, recordContextId: r.recordContextId, recordContextType: r.recordContextType },
        r.tool, error, r.args, 'failed',
      );
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'background_sweep_failed');
  }
}

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
 * Truth is kept two ways: the next turn waits for this session's pending
 * writes before it reads the record (so the prompt shows what was
 * written, not what was there before), and every outcome finished since
 * the last reply is put in front of the model as "Background results",
 * so a failed write is corrected in the next reply. A failure also leaves
 * a follow-up Task on the record for a person.
 *
 * Never background: reads (the reply depends on them) and approval-gated
 * writes (a person decides first).
 */
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AIMessage } from '@langchain/core/messages';
import { prisma } from '../db/client';
import { getOrgConnection } from '../salesforce/per-org-connection';
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
  const prev = chains.get(meta.sessionId) ?? Promise.resolve();
  const next = prev
    .catch(() => { /* a failed job never blocks the next */ })
    .then(() => runJob(row.id, meta, t, args));
  chains.set(meta.sessionId, next);
  void next.finally(() => { if (chains.get(meta.sessionId) === next) chains.delete(meta.sessionId); });
  return { id: row.id, queuedAt: row.queuedAt };
}

async function runJob(id: string, meta: BackgroundMeta, t: StructuredToolInterface, args: unknown): Promise<void> {
  const startedAt = new Date();
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
    logger.info({ orgId: meta.orgId, sessionId: meta.sessionId, tool: t.name, ms: Date.now() - startedAt.getTime(), failed: failedInside }, 'background_tool_done');
    if (failedInside) await leaveFollowUpTask(meta, t.name, text.slice(0, 500), args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.backgroundToolRun.update({
      where: { id },
      data: { status: 'failed', error: message.slice(0, 500), finishedAt: new Date(), ms: Date.now() - startedAt.getTime() },
    }).catch(() => { /* best effort */ });
    logger.error({ orgId: meta.orgId, sessionId: meta.sessionId, tool: t.name, err: message }, 'background_tool_failed');
    await leaveFollowUpTask(meta, t.name, message, args);
  }
}

/** A write that failed after the customer was told it was done leaves a
 *  Task on the record so a person sees it even if the customer goes quiet. */
async function leaveFollowUpTask(meta: BackgroundMeta, toolName: string, error: string, args: unknown): Promise<void> {
  if (!meta.recordContextId) return;
  try {
    const conn = await getOrgConnection(meta.orgId);
    const isPerson = meta.recordContextType === 'Lead' || meta.recordContextType === 'Contact';
    await conn.sobject('Task').create({
      Subject: `Agent action failed: ${toolName}`,
      Description: `The ${meta.agentApiName} agent told the customer this was done, but it failed afterwards.\n\nError: ${error}\n\nArguments: ${JSON.stringify(args).slice(0, 1500)}`,
      Status: 'Not Started',
      Priority: 'High',
      ActivityDate: new Date().toISOString().slice(0, 10),
      ...(isPerson ? { WhoId: meta.recordContextId } : { WhatId: meta.recordContextId }),
    });
  } catch (err) {
    logger.warn({ orgId: meta.orgId, err: err instanceof Error ? err.message : String(err) }, 'background_follow_up_task_failed');
  }
}

/** Wrap a tool so a call queues instead of running. The answer the model
 *  reads says so plainly; the prompt line tells it what that means. */
export function backgroundGate(meta: BackgroundMeta): (t: StructuredToolInterface) => StructuredToolInterface {
  return (t: StructuredToolInterface) =>
    tool(
      async (args: unknown) => {
        const { id } = await enqueue(meta, t, args);
        return JSON.stringify({ queued: true, job: id, note: 'This action runs in the background right after your reply. Treat it as done; a later "Background results" note reports the outcome.' });
      },
      { name: t.name, description: t.description, schema: t.schema },
    ) as StructuredToolInterface;
}

/** Wait for this session's queued writes, so the next prompt reads the
 *  record as written. Bounded: a slow write must not stall the turn. */
export async function awaitPendingBackground(sessionId: string, capMs = 2_000): Promise<number> {
  const chain = chains.get(sessionId);
  if (!chain) return 0;
  const t0 = Date.now();
  await Promise.race([chain.catch(() => undefined), new Promise(r => setTimeout(r, capMs))]);
  return Date.now() - t0;
}

/**
 * The outcomes finished since they were last shown, as a prompt block --
 * and mark them shown, so a failure is reported once, not on every turn.
 */
export async function backgroundResultsBlock(sessionId: string): Promise<string | null> {
  let rows: Array<{ id: string; tool: string; status: string; error: string | null; args: unknown; finishedAt: Date | null }> = [];
  try {
    rows = await prisma.backgroundToolRun.findMany({
      where: { sessionId, reportedAt: null, status: { in: ['done', 'failed'] } },
      orderBy: { queuedAt: 'asc' },
      take: 20,
    });
  } catch (err) {
    logger.warn({ sessionId, err: err instanceof Error ? err.message : String(err) }, 'background_results_read_failed');
    return null;
  }
  if (rows.length === 0) return null;
  const lines = rows.map(r => {
    const what = describeArgs(r.args);
    return r.status === 'failed'
      ? `- ${r.tool}${what} — FAILED: ${(r.error ?? 'unknown error').slice(0, 240)}`
      : `- ${r.tool}${what} — succeeded`;
  });
  void prisma.backgroundToolRun.updateMany({ where: { id: { in: rows.map(r => r.id) } }, data: { reportedAt: new Date() } }).catch(() => { /* best effort */ });
  return (
    'BACKGROUND RESULTS since your last reply (actions you already told the customer were done):\n' +
    lines.join('\n') +
    '\nIf one FAILED, tell the customer plainly that it did not save and ask again for what it needed. Never repeat a succeeded action.'
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
    'When every tool you need in a step is one of these, write the customer\'s reply in the SAME message as the tool calls and treat the action as done. ' +
    'If a later "Background results" note says one failed, tell the customer and ask again.'
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
 *  is gone. Mark it, so the next turn reports it instead of waiting. */
export async function sweepOrphanedBackgroundRuns(): Promise<void> {
  try {
    const { count } = await prisma.backgroundToolRun.updateMany({
      where: { status: { in: ['queued', 'running'] } },
      data: { status: 'failed', error: 'The server restarted before this action ran.', finishedAt: new Date() },
    });
    if (count > 0) logger.warn({ count }, 'background_runs_orphaned_by_restart');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'background_sweep_failed');
  }
}

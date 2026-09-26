import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

/**
 * A background tool answers the model at once and runs right after, in
 * order per session; its outcome is reported to the next turn once; a
 * failure leaves a Task. The turn ends on reply text when every call in
 * the step is a background one.
 */
const rows = new Map<string, Record<string, unknown>>();
let seq = 0;
const taskCreates: unknown[] = [];

vi.mock('../src/db/client', () => ({
  prisma: {
    backgroundToolRun: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `bg_${++seq}`;
        const row = { id, queuedAt: new Date(), reportedAt: null, result: null, error: null, ...data };
        rows.set(id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.get(where.id)!;
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id?: { in: string[] }; status?: { in: string[] } }; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of rows.values()) {
          const idOk = !where.id || where.id.in.includes(row.id as string);
          const stOk = !where.status || where.status.in.includes(row.status as string);
          if (idOk && stOk) { Object.assign(row, data); count++; }
        }
        return { count };
      }),
      findMany: vi.fn(async ({ where }: { where: { sessionId: string; reportedAt: null; status: { in: string[] } } }) =>
        [...rows.values()].filter(r => r.sessionId === where.sessionId && r.reportedAt === null && where.status.in.includes(r.status as string))),
    },
  },
}));

vi.mock('../src/salesforce/per-org-connection', () => ({
  getOrgConnection: vi.fn(async () => ({ sobject: () => ({ create: vi.fn(async (t: unknown) => { taskCreates.push(t); return { id: '00T1' }; }) }) })),
}));

const {
  backgroundGate, awaitPendingBackground, backgroundResultsBlock, backgroundToolNames, backgroundPromptLine, speaksThenActs, sweepOrphanedBackgroundRuns, mustRunInline, _forgetCreatedAnchors,
} = await import('../src/lc/background-tools');

const meta = { orgId: '00D', sessionId: 'sess-1', agentApiName: 'intake', recordContextId: '00Q1', recordContextType: 'Lead' };
const order: string[] = [];
const slowUpdate = tool(async (args: { field: string; ms?: number }) => {
  await new Promise(r => setTimeout(r, args.ms ?? 30));
  order.push(args.field);
  return JSON.stringify({ success: true, id: '00Q1' });
}, { name: 'updateSobjectRecord', description: 'd', schema: z.object({ field: z.string(), ms: z.number().optional() }) });
const rejecting = tool(async () => JSON.stringify({ success: false, message: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: Budget__c' }),
  { name: 'updateSobjectRecord', description: 'd', schema: z.object({ field: z.string() }) });

describe('background tools', () => {
  beforeEach(() => { rows.clear(); seq = 0; order.length = 0; taskCreates.length = 0; });

  it('answers queued at once, then runs the calls in order and records the outcomes', async () => {
    const bg = backgroundGate(meta)(slowUpdate);
    const t0 = Date.now();
    const a = JSON.parse(String(await bg.invoke({ field: 'Email', ms: 60 })));
    const b = JSON.parse(String(await bg.invoke({ field: 'Budget', ms: 10 })));
    expect(Date.now() - t0).toBeLessThan(50);          // neither write was waited for
    expect(a.queued).toBe(true);
    expect(b.job).not.toBe(a.job);
    await awaitPendingBackground('sess-1', 5_000);
    expect(order).toEqual(['Email', 'Budget']);          // Budget was faster, still ran second
    expect([...rows.values()].map(r => r.status)).toEqual(['done', 'done']);
  });

  it('the next turn waits for pending writes, bounded', async () => {
    const bg = backgroundGate(meta)(slowUpdate);
    await bg.invoke({ field: 'Email', ms: 300 });
    const waited = await awaitPendingBackground('sess-1', 100);
    expect(waited).toBeGreaterThanOrEqual(90);
    expect(waited).toBeLessThan(250);                    // the cap, not the write
    await awaitPendingBackground('sess-1', 5_000);
  });

  it('reports outcomes once, and a rejected write reads as FAILED with a Task left behind', async () => {
    const bg = backgroundGate({ ...meta, sessionId: 'sess-2' })(rejecting);
    await bg.invoke({ field: 'Budget' });
    await awaitPendingBackground('sess-2', 5_000);
    const block = await backgroundResultsBlock('sess-2');
    expect(block).toContain('FAILED');
    expect(block).toContain('INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST');
    expect(await backgroundResultsBlock('sess-2')).toBeNull();   // reported once
    expect(taskCreates).toHaveLength(1);
    expect(taskCreates[0]).toMatchObject({ WhoId: '00Q1', Priority: 'High' });
  });

  it('names come from tool nodes and catalog nodes, never from an approval-gated tool', () => {
    const agent = { nodes: [
      { nodeType: 'tool', isEnabled: true, config: { toolName: 'createSobjectRecord', runInBackground: true } },
      { nodeType: 'tool', isEnabled: true, config: { toolName: 'deleteSobjectRecord', runInBackground: true, requiresApproval: true } },
      { nodeType: 'catalog', isEnabled: true, config: { allowedTools: ['find', 'updateSobjectRecord'], backgroundTools: ['updateSobjectRecord'] } },
      { nodeType: 'tool', isEnabled: false, config: { toolName: 'soqlQuery', runInBackground: true } },
    ] } as never;
    expect([...backgroundToolNames(agent)].sort()).toEqual(['createSobjectRecord', 'updateSobjectRecord']);
    expect(backgroundPromptLine(new Set())).toBeNull();
    expect(backgroundPromptLine(new Set(['updateSobjectRecord']))).toContain('same assistant message');
  });

  it('speaks-then-acts only when there is text and every call is a background tool', () => {
    const names = new Set(['updateSobjectRecord']);
    const withText = new AIMessage({ content: 'Saved. Next?', tool_calls: [{ id: '1', name: 'updateSobjectRecord', args: {}, type: 'tool_call' }] });
    const noText = new AIMessage({ content: '', tool_calls: [{ id: '1', name: 'updateSobjectRecord', args: {}, type: 'tool_call' }] });
    const mixed = new AIMessage({ content: 'Looking…', tool_calls: [{ id: '1', name: 'updateSobjectRecord', args: {}, type: 'tool_call' }, { id: '2', name: 'find', args: {}, type: 'tool_call' }] });
    expect(speaksThenActs(withText, names)).toBe(true);
    expect(speaksThenActs(noText, names)).toBe(false);
    expect(speaksThenActs(mixed, names)).toBe(false);
    expect(speaksThenActs(withText, new Set())).toBe(false);
  });

  it('a create runs inline while the conversation has no record, and in the background once it has one', async () => {
    const created = tool(async () => JSON.stringify({ success: true, id: '00Qg5000008kiKnEAI' }), { name: 'createSobjectRecord', description: 'd', schema: z.object({ field: z.string() }) });
    expect(mustRunInline('createSobjectRecord', { ...meta, recordContextId: null })).toBe(true);
    expect(mustRunInline('createSobjectRecord', meta)).toBe(false);
    expect(mustRunInline('updateSobjectRecord', { ...meta, recordContextId: null })).toBe(false);
    const inline = JSON.parse(String(await backgroundGate({ ...meta, sessionId: 'sess-3', recordContextId: null })(created).invoke({ field: 'x' })));
    expect(inline).toEqual({ success: true, id: '00Qg5000008kiKnEAI' });      // the Id comes back, nothing queued
    const queued = JSON.parse(String(await backgroundGate({ ...meta, sessionId: 'sess-3' })(created).invoke({ field: 'x' })));
    expect(queued.queued).toBe(true);
    await awaitPendingBackground('sess-3', 5_000);
    // The inline create above left the conversation with a record: the next
    // create in the same session (an Event, a Task) goes to the background.
    const second = JSON.parse(String(await backgroundGate({ ...meta, sessionId: 'sess-3', recordContextId: null })(created).invoke({ field: 'y' })));
    expect(second.queued).toBe(true);
    await awaitPendingBackground('sess-3', 5_000);
    _forgetCreatedAnchors();
  });

  it('a failure with no anchored record still leaves a Task', async () => {
    const bg = backgroundGate({ ...meta, sessionId: 'sess-4', recordContextId: null })(rejecting);
    await bg.invoke({ field: 'Budget' });
    await awaitPendingBackground('sess-4', 5_000);
    expect(taskCreates).toHaveLength(1);
    expect(taskCreates[0]).not.toHaveProperty('WhoId');
  });

  it('a restart marks whatever was still queued as failed', async () => {
    rows.set('bg_x', { id: 'bg_x', sessionId: 'sess-9', status: 'queued', reportedAt: null });
    await sweepOrphanedBackgroundRuns();
    expect(rows.get('bg_x')!.status).toBe('failed');
  });
});

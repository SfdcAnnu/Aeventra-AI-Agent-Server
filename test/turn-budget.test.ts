/**
 * When the brake falls inside a specialist that already produced results,
 * the root gets those results to report — not the generic reply.
 */
import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { createTurnBudget, partialWorkReport } from '../src/lc/turn-budget';

describe('partialWorkReport', () => {
  it('is null when the specialist ran no tool', () => {
    expect(partialWorkReport([new HumanMessage('task'), new AIMessage('thinking')])).toBeNull();
  });
  it('names every tool run and carries the last results, clipped', () => {
    const big = 'x'.repeat(3000);
    const msgs = [
      new HumanMessage('task'),
      new ToolMessage({ tool_call_id: '1', name: 'resolve_object', content: '{"resolved":"Lead"}' }),
      new ToolMessage({ tool_call_id: '2', name: 'describe_object', content: big }),
      new ToolMessage({ tool_call_id: '3', name: 'validate', content: '{"ok":true}' }),
      new ToolMessage({ tool_call_id: '4', name: 'serialize', content: '{"changeId":"chg_1"}' }),
    ];
    const r = JSON.parse(partialWorkReport(msgs, { reason: 'token_budget' })!) as { status: string; reason: string; toolsRun: string[]; findings: Array<{ tool: string; result: string }> };
    expect(r.status).toBe('stopped');
    expect(r.reason).toBe('token_budget');
    expect(r.toolsRun).toEqual(['resolve_object', 'describe_object', 'validate', 'serialize']);
    expect(r.findings.map(f => f.tool)).toEqual(['describe_object', 'validate', 'serialize']); // the last three
    expect(r.findings[2].result).toBe('{"changeId":"chg_1"}');
    expect(r.findings[0].result.length).toBeLessThan(600); // clipped for the root
    expect(JSON.stringify(r).length).toBeLessThan(2000); // never spilled to an artifact
    const full = JSON.parse(partialWorkReport(msgs, { full: true })!) as { findings: Array<{ result: string }> };
    expect(full.findings).toHaveLength(4);
    expect(full.findings[1].result.length).toBeGreaterThan(1500); // kept for the re-dispatch
  });
  it('a fresh budget has no grace call', () => {
    expect(createTurnBudget({}).graceLeft).toBe(0);
  });
  it('a websocket turn may run past the Apex callout limit; an HTTP turn may not', () => {
    const cfg = { budgets: { maxMs: 540_000 } };
    const http = createTurnBudget(cfg).deadlineAt - Date.now();
    const ws = createTurnBudget(cfg, { transport: 'ws' }).deadlineAt - Date.now();
    expect(http).toBeLessThanOrEqual(110_000);
    expect(ws).toBeGreaterThan(500_000);
  });
});

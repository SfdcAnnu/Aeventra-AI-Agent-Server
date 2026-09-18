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
    const r = partialWorkReport(msgs)!;
    expect(r).toMatch(/^STOPPED BY THE TURN BUDGET/);
    expect(r).toContain('Tools run: resolve_object, describe_object, validate, serialize');
    expect(r).toContain('serialize: {"changeId":"chg_1"}');
    expect(r).not.toContain('resolve_object: {'); // only the last three results
    expect(r.length).toBeLessThan(3000);
  });
  it('a fresh budget has no grace call', () => {
    expect(createTurnBudget({}).graceLeft).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { applyPromptMap, applySpecPatch, isSpecPatch } from '../src/architect/spec-merge';
import type { AgentSpec } from '../src/architect/spec';

/**
 * The Prompt Engineer and the designer's repair round used to re-emit the
 * whole spec to change part of it. Merging in code cannot drop an edge,
 * cannot forget a node, and costs nothing.
 */
const base = (): AgentSpec => ({
  specVersion: '1.0',
  trigger: { type: 'inbound_message', channel: 'whatsapp' },
  nodes: [
    { id: 'root', type: 'agent', label: 'Intake' },
    { id: 'qual', type: 'subagent', label: 'Qualifier', description: 'when the lead answers' },
    { id: 'find', type: 'tool', label: 'Find lead', action: { kind: 'mcp', toolName: 'find', discovered: true } },
    { id: 'create', type: 'tool', label: 'Create lead', action: { kind: 'crud', sobject: 'Lead', operation: 'create', discovered: true } },
  ],
  edges: [
    { from: 'root', to: 'qual', mode: 'call', contextPolicy: 'isolated' },
    { from: 'root', to: 'find', mode: 'static' },
    { from: 'qual', to: 'create', mode: 'static' },
  ],
} as unknown as AgentSpec);

describe('applyPromptMap', () => {
  it('sets instructions and descriptions by id and reports what is still empty', () => {
    const spec = base();
    const r = applyPromptMap(spec, {
      instructions: { root: 'ROLE\nYou greet.', qual: 'ROLE\nYou qualify.', ghost: 'nobody' },
      descriptions: { find: 'Use to look a lead up by phone.', qual: 'when a lead replies' },
    });
    expect(r.applied).toBe(4);
    expect(r.unknownIds).toEqual(['ghost']);
    expect(r.missing).toEqual(['create (description)']);
    expect(spec.nodes.find(n => n.id === 'qual')).toMatchObject({ instructions: 'ROLE\nYou qualify.', description: 'when a lead replies' });
    expect(spec.edges).toHaveLength(3);
  });
  it('reads the old whole-spec shape the same way, without taking its edges', () => {
    const spec = base();
    const r = applyPromptMap(spec, { nodes: [{ id: 'root', instructions: 'hello' }, { id: 'find', description: 'd' }], edges: [] });
    expect(r.applied).toBe(2);
    expect(spec.nodes[0].instructions).toBe('hello');
    expect(spec.edges).toHaveLength(3);
  });
  it('ignores blanks and non-strings', () => {
    const spec = base();
    const r = applyPromptMap(spec, { instructions: { root: '   ', qual: 42 } });
    expect(r.applied).toBe(0);
    expect(r.missing).toContain('root (instructions)');
  });
});

describe('applySpecPatch', () => {
  it('replaces by id, appends the new, removes with its edges, and leaves the original alone', () => {
    const spec = base();
    const r = applySpecPatch(spec, {
      nodes: [
        { id: 'create', type: 'tool', label: 'Create lead', approval: { required: true }, action: { kind: 'crud', sobject: 'Lead', operation: 'create', discovered: true } },
        { id: 'event', type: 'tool', label: 'Book meeting', action: { kind: 'crud', sobject: 'Event', operation: 'create', discovered: true } },
      ],
      removeNodeIds: ['find'],
    } as never);
    expect(r.changedIds).toEqual(['create', 'event']);
    expect(r.removedIds).toEqual(['find']);
    expect(r.edgesReplaced).toBe(false);
    expect(r.spec.nodes.map(n => n.id)).toEqual(['root', 'qual', 'create', 'event']);
    expect(r.spec.nodes.find(n => n.id === 'create')!.approval).toEqual({ required: true });
    expect(r.spec.edges.map(e => `${e.from}>${e.to}`)).toEqual(['root>qual', 'qual>create']);
    expect(spec.nodes).toHaveLength(4);
    expect(spec.edges).toHaveLength(3);
  });
  it('replaces the edge list only when the patch carries one', () => {
    const r = applySpecPatch(base(), { edges: [{ from: 'root', to: 'find', mode: 'static' }] });
    expect(r.edgesReplaced).toBe(true);
    expect(r.spec.edges).toHaveLength(1);
  });
  it('knows a patch from prose', () => {
    expect(isSpecPatch({ nodes: [] })).toBe(true);
    expect(isSpecPatch({ removeNodeIds: ['x'] })).toBe(true);
    expect(isSpecPatch({ summary: 'fixed it' })).toBe(false);
    expect(isSpecPatch(null)).toBe(false);
  });
});

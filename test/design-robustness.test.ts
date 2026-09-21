import { describe, it, expect } from 'vitest';
import { attachOrphansToRoot } from '../src/architect/spec';
import type { AgentSpec } from '../src/architect/spec';

/**
 * attachOrphansToRoot runs on a RAW model answer, before anything has
 * validated it. A design that came back without `nodes` used to throw
 * "Cannot read properties of undefined (reading 'filter')" here, which
 * killed a build that had already been paid for — and killed it outside
 * the retry loop, so the model never got the chance to correct itself.
 *
 * Nothing below asserts that a shapeless answer is acceptable. It asserts
 * that recognising one is validateSpec's job, and that the free repair
 * step declines quietly instead of taking the build down with it.
 */
describe('attachOrphansToRoot on a malformed design', () => {
  const shapeless: unknown[] = [
    {},
    { nodes: undefined, edges: [] },
    { nodes: [], edges: undefined },
    { nodes: 'not an array', edges: [] },
    { spec: { nodes: [], edges: [] } }, // wrapped in another key
    null,
    undefined,
  ];

  for (const [i, bad] of shapeless.entries()) {
    it(`declines to repair shapeless answer #${i + 1} instead of throwing`, () => {
      expect(() => attachOrphansToRoot(bad as AgentSpec)).not.toThrow();
      expect(attachOrphansToRoot(bad as AgentSpec)).toEqual([]);
    });
  }

  it('still repairs a well-formed design', () => {
    const spec = {
      nodes: [
        { id: 'root', type: 'agent', label: 'Root' },
        { id: 'helper', type: 'subagent', label: 'Helper' },
      ],
      edges: [],
    } as unknown as AgentSpec;

    const notes = attachOrphansToRoot(spec);
    // The orphan is wired to the root, and the repair says so.
    expect(notes.length).toBeGreaterThan(0);
    expect(spec.edges).toHaveLength(1);
    expect(spec.edges[0]).toMatchObject({ from: 'root', to: 'helper' });
  });

  it('leaves a design that is already wired alone', () => {
    const spec = {
      nodes: [
        { id: 'root', type: 'agent', label: 'Root' },
        { id: 'helper', type: 'subagent', label: 'Helper' },
      ],
      edges: [{ from: 'root', to: 'helper' }],
    } as unknown as AgentSpec;

    expect(attachOrphansToRoot(spec)).toEqual([]);
    expect(spec.edges).toHaveLength(1);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSpec, assertActivatable, type AgentSpec } from '../src/architect/spec';

/**
 * THE ARCHITECT'S OWN DEFINITION MUST PASS THE VALIDATOR THE ARCHITECT
 * ENFORCES ON EVERYTHING IT BUILDS.
 *
 * It did not. For an unknown stretch the spec carried eight sub-agents
 * with no `description` — the field the lead model routes on, so the
 * Architect's graph could not have routed itself — and a `save_agent`
 * declared as a crud `upsert` on Archon_Agent__c: an operation the
 * compiler does not support, on an object that is not what gets written,
 * through a mechanism that is not what happens.
 *
 * Nothing caught it because nothing ran the check. scripts/architect-verify.ts
 * existed and `npm test` is vitest, so the two never met. That is the
 * actual defect; the rest were symptoms of nobody looking.
 */
const spec = JSON.parse(
  readFileSync(join(process.cwd(), 'architect', 'schemas', 'architect.agentspec.json'), 'utf8'),
) as AgentSpec;

describe('the Architect spec', () => {
  it('validates against the schema and the logic rules', () => {
    expect(validateSpec(spec).map(e => `${e.path}: ${e.message}`)).toEqual([]);
  });

  it('is activatable — published, with nothing blocking', () => {
    expect(() => assertActivatable(spec)).not.toThrow();
  });

  it('gives every sub-agent the description the lead routes on', () => {
    for (const n of spec.nodes.filter(n => n.type === 'subagent')) {
      expect(n.description, `${n.id} has no description`).toBeTruthy();
    }
  });

  it('declares only stages the pipeline actually runs', () => {
    // design_tests, run_tests and build_report described a test-and-report
    // loop that has never run. A spec promising work nobody does is read
    // by a model as licence to behave as though it happened.
    const ids = spec.nodes.map(n => n.id);
    for (const gone of ['design_tests', 'run_tests', 'build_report']) {
      expect(ids, `${gone} is back without the pipeline to match`).not.toContain(gone);
    }
  });

  it('leaves no edge pointing at a node that is not there', () => {
    const ids = new Set(spec.nodes.map(n => n.id));
    for (const e of spec.edges) {
      expect(ids.has(e.from), `edge from missing node ${e.from}`).toBe(true);
      expect(ids.has(e.to), `edge to missing node ${e.to}`).toBe(true);
    }
  });
});

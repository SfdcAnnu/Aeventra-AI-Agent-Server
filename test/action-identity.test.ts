import { describe, it, expect } from 'vitest';
import { validateSpecLogic, manifestFromNames } from '../src/architect/spec';
import type { AgentSpec } from '../src/architect/spec';

/**
 * The build this pins cost $1.96 and died with four copies of one message:
 *
 *   /nodes/query_salesforce/action: references crud '?:query' which the
 *   Org Surveyor did not discover
 *
 * Two faults met. The designer had been told "one tool node per TOOL, not
 * one per record type", so it emitted a single generic `query_salesforce`
 * CRUD node and left `sobject` out — but CRUD is vouched per object, so a
 * CRUD action without one can never validate, whatever the org contains.
 * And the message it got back named no object, no field and no fix, so it
 * made the same design three times running.
 *
 * What these tests hold: a missing field is reported AS a missing field,
 * in words that say what to write instead.
 */
const base = (action: Record<string, unknown>) => ({
  specVersion: '1.0',
  trigger: { type: 'inbound_message' },
  nodes: [
    { id: 'root', type: 'agent', label: 'Root' },
    { id: 'tool_node', type: 'tool', label: 'Do the thing', action },
  ],
  edges: [{ from: 'root', to: 'tool_node', mode: 'call' }],
}) as unknown as AgentSpec;

const org = manifestFromNames([
  'crud:Lead:create', 'crud:Lead:update', 'crud:Lead:query',
  'mcp:getObjectSchema', 'mcp:soqlQuery',
]);

describe('a crud action must name its object', () => {
  it('rejects the generic node the live build produced', () => {
    const errors = validateSpecLogic(base({ kind: 'crud', operation: 'query', discovered: true }), org);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('/nodes/tool_node/action');
    expect(errors[0].message).toContain('action.sobject');
  });

  it('says what to write instead, which is the part that was missing', () => {
    const [err] = validateSpecLogic(base({ kind: 'crud', operation: 'create', discovered: true }), org);
    // The designer wanted one node across objects. That is the MCP tool.
    expect(err.message).toContain('kind "mcp"');
  });

  it('never reports "?" as though it were a tool name', () => {
    const errors = validateSpecLogic(base({ kind: 'crud', operation: 'update', discovered: true }), org);
    expect(errors.some(e => e.message.includes("'?:"))).toBe(false);
  });

  it('rejects a crud action with no operation', () => {
    const errors = validateSpecLogic(base({ kind: 'crud', sobject: 'Lead', discovered: true }), org);
    expect(errors.some(e => e.message.includes('action.operation'))).toBe(true);
  });

  it('reports the missing field ONCE, not alongside a lookup it could not do', () => {
    const errors = validateSpecLogic(base({ kind: 'crud', operation: 'query', discovered: true }), org);
    expect(errors.some(e => e.message.includes('did not discover'))).toBe(false);
  });

  it('accepts a crud action that names both', () => {
    expect(validateSpecLogic(base({ kind: 'crud', sobject: 'Lead', operation: 'create', discovered: true }), org)).toEqual([]);
  });

  it('still catches an object the org does not permit', () => {
    const errors = validateSpecLogic(base({ kind: 'crud', sobject: 'Ghost__c', operation: 'create', discovered: true }), org);
    expect(errors[0].message).toContain('did not discover');
  });
});

describe('a named tool must be named', () => {
  it('rejects an mcp action with no toolName', () => {
    const errors = validateSpecLogic(base({ kind: 'mcp', connector: 'salesforce_mcp', discovered: true }), org);
    expect(errors[0].message).toContain('action.toolName');
  });

  it('rejects the invented spelling the live build used', () => {
    // The server publishes getObjectSchema. The model wrote snake_case.
    const errors = validateSpecLogic(base({ kind: 'mcp', toolName: 'get_sobject_schema', discovered: true }), org);
    expect(errors[0].message).toContain('did not discover');
    expect(errors[0].message).toContain('case-sensitive');
  });

  it('accepts the spelling the server actually publishes', () => {
    expect(validateSpecLogic(base({ kind: 'mcp', toolName: 'getObjectSchema', discovered: true }), org)).toEqual([]);
  });

  it('does not accuse http of being an undiscovered tool', () => {
    // http names no discovered capability, so the manifest has nothing to
    // vouch for. It used to be looked up anyway and came back as
    // "references http 'undefined'" — which reads as an invented tool on
    // top of the real complaint, and the real complaint is the next line.
    const errors = validateSpecLogic(base({ kind: 'http', discovered: true }), org);
    expect(errors.some(e => e.message.includes('did not discover'))).toBe(false);
    expect(errors.some(e => e.message.includes('no runtime executor'))).toBe(true);
  });
});

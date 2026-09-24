import { describe, it, expect } from 'vitest';
import { manifestFromInventory } from '../src/architect/surveyor-tools';

/**
 * The build read the org twice; only the survey's read waited out a cold
 * tool server, and the validator judged designs against the other one.
 * A real build rejected getObjectSchema, soqlQuery and createSobjectRecord
 * three times with 44 tools in the survey. One inventory, one manifest.
 */
describe('manifestFromInventory', () => {
  const objects = [{ name: 'Lead', label: 'Lead', custom: false, queryable: true, createable: true, updateable: true }];
  const invocables = [{ kind: 'flow' as const, name: 'Send_Welcome', label: 'Send welcome' }];

  it('vouches for exactly what the inventory holds', () => {
    const mcp = [{ provider: 'salesforce_mcp', url: 'u', tools: [{ name: 'getObjectSchema', description: '' }, { name: 'soqlQuery', description: '' }] }];
    const { manifest, counts } = manifestFromInventory(objects, invocables, mcp);
    expect(manifest.has('mcp', 'getObjectSchema')).toBe(true);
    expect(manifest.has('mcp', 'soqlQuery')).toBe(true);
    expect(manifest.has('mcp', 'getPicklistValues')).toBe(false);
    expect(manifest.has('flow_invocable', 'Send_Welcome')).toBe(true);
    expect(manifest.has('crud', 'Lead:create')).toBe(true);
    expect(manifest.has('crud', 'Lead:delete')).toBe(false);
    expect(counts).toEqual({ objects: 1, invocables: 1, mcpTools: 2, crudOperations: 3 });
  });

  it('a server that answered with an error contributes nothing -- and the cold read is not the one that counts', () => {
    const cold = [{ provider: 'salesforce_mcp', url: 'u', tools: [], error: 'The tool server is busy right now.' }];
    expect(manifestFromInventory(objects, invocables, cold).manifest.has('mcp', 'getObjectSchema')).toBe(false);
    const warm = [{ provider: 'salesforce_mcp', url: 'u', tools: [{ name: 'getObjectSchema', description: '' }] }];
    expect(manifestFromInventory(objects, invocables, warm).manifest.has('mcp', 'getObjectSchema')).toBe(true);
  });
});

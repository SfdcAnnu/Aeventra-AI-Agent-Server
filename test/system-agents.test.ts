/**
 * A system agent spec lays out as the canvas records the runtime reads:
 * one ai root, sub-agents and tools on its tool port, tools on each
 * sub-agent's tool port, every tool naming its server, no catalog node.
 */
import { describe, expect, it } from 'vitest';
import { layoutSystemAgent } from '../src/platform/system-agents';
import { metadataSmokeAgent } from '../src/platform/agents/metadata-smoke';
import type { ArchitectEngine } from '../src/architect/specialists';

const engine: ArchitectEngine = { nodeSubType: 'gpt4', engineType: 'openai', apiKey: 'k', endpoint: null, models: ['gpt-4.1-mini', 'gpt-4.1', 'o3'] };

describe('layoutSystemAgent', () => {
  const { nodes, connections } = layoutSystemAgent(metadataSmokeAgent, engine);

  it('writes one ai root, the sub-agents, and every tool as its own node — no catalog', () => {
    expect(nodes[0].nodeType).toBe('ai');
    expect(nodes.filter(n => n.nodeType === 'subagent')).toHaveLength(1);
    expect(nodes.filter(n => n.nodeType === 'tool')).toHaveLength(3 + 6);
    expect(nodes.some(n => (n.nodeType as string) === 'catalog')).toBe(false);
  });
  it('wires everything through the tool port, the one port the runtime reads', () => {
    expect(connections.every(c => c.fromPort === 'tool' && c.toPort === 'in')).toBe(true);
    const fromRoot = connections.filter(c => c.fromIndex === 0).map(c => nodes[c.toIndex].name);
    expect(fromRoot).toEqual(['Deploy change', 'Deploy status', 'List agents', 'Schema Specialist']);
    const sub = nodes.findIndex(n => n.nodeType === 'subagent');
    expect(connections.filter(c => c.fromIndex === sub)).toHaveLength(6);
    expect(new Set(connections.map(c => c.id)).size).toBe(connections.length);
  });
  it('tool nodes name their server and carry the approval flag', () => {
    const deploy = nodes.find(n => n.name === 'Deploy change')!;
    expect(deploy.config).toMatchObject({ actionType: 'MCP', toolName: 'deploy', connectorId: 'salesforce_metadata', requiresApproval: true });
    const list = nodes.find(n => n.name === 'List agents')!;
    expect(list.config).toMatchObject({ connectorId: 'archon_platform', requiresApproval: false });
  });
  it('resolves the tier to a model of the org engine and marks the nodes as system-managed', () => {
    expect(nodes[0].nodeSubType).toBe('gpt4');
    expect(nodes[0].config).toMatchObject({ model: 'o3', system: true, specVersion: 1, customerFacing: false });
    const sub = nodes.find(n => n.nodeType === 'subagent')!;
    expect(sub.config).toMatchObject({ mode: 'call', contextPolicy: 'isolated', model: 'o3', system: true });
  });
});

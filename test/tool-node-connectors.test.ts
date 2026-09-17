/**
 * Connections derived from tool nodes: which providers an agent names,
 * where their addresses come from, and that catalog connections win.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { augmentConnectorsWithToolNodes, forgetProviderUrls, platformBaseUrl, providersNamedByToolNodes } from '../src/chat/tool-node-connectors';
import type { AgentDefinition, AgentNode } from '../src/types';

const node = (over: Partial<AgentNode>): AgentNode => ({
  id: over.id ?? 'n', name: over.name ?? 'N', nodeType: over.nodeType ?? 'tool', nodeSubType: over.nodeSubType ?? 'mcp',
  config: over.config ?? {}, isEnabled: over.isEnabled ?? true, ...over,
} as AgentNode);

const agent = (nodes: AgentNode[]): AgentDefinition => ({ id: 'a', name: 'Archon', apiName: 'archon_copilot', status: 'Active', accessMode: 'Org', nodes });

function fakeConn(rows: Array<{ DeveloperName: string; McpServerUrl__c: string }>) {
  return {
    instanceUrl: 'https://org.example',
    query: async (soql: string) => {
      if (soql.includes('ConnectorCatalog__mdt')) return { records: rows };
      if (soql.includes('CustomMcpServer__c')) return { records: [{ Id: 'a0X1', McpServerUrl__c: 'https://custom.example/' }] };
      throw new Error(`unexpected ${soql}`);
    },
  } as never;
}

beforeEach(() => forgetProviderUrls());

describe('providersNamedByToolNodes', () => {
  it('collects the connector keys of enabled MCP tool nodes, Salesforce Platform for the rest', () => {
    const a = agent([
      node({ id: 't1', config: { actionType: 'MCP', connectorId: 'salesforce_metadata', toolName: 'deploy' } }),
      node({ id: 't2', config: { actionType: 'MCP', connectorId: 'archon_platform', toolName: 'list_agents' } }),
      node({ id: 't3', config: { actionType: 'Flow', toolName: 'Create_Lead' } }),
      node({ id: 't4', isEnabled: false, config: { actionType: 'MCP', connectorId: 'gmail', toolName: 'send' } }),
      node({ id: 'ai', nodeType: 'ai', nodeSubType: 'gpt4' }),
    ]);
    expect([...providersNamedByToolNodes(a)].sort()).toEqual(['archon_platform', 'salesforce_mcp', 'salesforce_metadata']);
  });
});

describe('augmentConnectorsWithToolNodes', () => {
  it('adds strict connections for named providers, from the catalog metadata and the loopback platform URL', async () => {
    const a = agent([
      node({ id: 't1', config: { actionType: 'MCP', connectorId: 'salesforce_metadata', toolName: 'deploy' } }),
      node({ id: 't2', config: { actionType: 'MCP', connectorId: 'archon_platform', toolName: 'list_agents' } }),
      node({ id: 't3', config: { actionType: 'MCP', connectorId: 'custom_a0X1', toolName: 'x' } }),
    ]);
    const out = await augmentConnectorsWithToolNodes(a, [], fakeConn([{ DeveloperName: 'salesforce_metadata', McpServerUrl__c: 'https://meta.example/' }]), 'https://org.my.salesforce.com');
    const byProvider = Object.fromEntries(out.map(c => [c.provider, c]));
    expect(byProvider.salesforce_metadata).toMatchObject({ mcpServerUrl: 'https://meta.example', scope: 'nodes', accessMode: 'Org', headers: { 'X-Salesforce-Instance-Url': 'https://org.my.salesforce.com' } });
    expect(byProvider.archon_platform).toMatchObject({ mcpServerUrl: platformBaseUrl(), scope: 'nodes', accessMode: null, headers: null });
    expect(byProvider.custom_a0X1).toMatchObject({ mcpServerUrl: 'https://custom.example', scope: 'nodes' });
  });
  it('leaves a provider alone when a catalog connection already carries it', async () => {
    const a = agent([node({ id: 't1', config: { actionType: 'MCP', connectorId: 'salesforce_metadata', toolName: 'deploy' } })]);
    const existing = [{ provider: 'salesforce_metadata', mcpServerUrl: 'https://cat.example', allowedTools: ['deploy'], connectorId: null, accessMode: null, customTools: null }];
    const out = await augmentConnectorsWithToolNodes(a, existing, fakeConn([{ DeveloperName: 'salesforce_metadata', McpServerUrl__c: 'https://meta.example' }]), null);
    expect(out).toBe(existing);
  });
  it('skips a provider the org has no address for, and keeps the others', async () => {
    const a = agent([
      node({ id: 't1', config: { actionType: 'MCP', connectorId: 'nowhere', toolName: 'x' } }),
      node({ id: 't2', config: { actionType: 'MCP', connectorId: 'archon_platform', toolName: 'list_agents' } }),
    ]);
    const out = await augmentConnectorsWithToolNodes(a, [], fakeConn([]), null);
    expect(out.map(c => c.provider)).toEqual(['archon_platform']);
  });
});

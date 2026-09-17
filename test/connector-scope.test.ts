/**
 * The scoping rule: what each node's request carries per MCP connection.
 * Catalog connections keep their toolset semantics; connections derived
 * from tool nodes are strict — exactly the node's own tool nodes, or
 * nothing.
 */
import { describe, expect, it } from 'vitest';
import { continuationMessage, mergeActionsIntoConnectors, providerOfAction } from '../src/chat/connector-scope';
import type { AgentAction } from '../src/types';
import type { ConnectorInput } from '../src/chat/adapters/types';

const action = (over: Partial<AgentAction>): AgentAction => ({
  id: over.id ?? over.toolName ?? 'a', name: over.name ?? over.toolName ?? 'A', description: '',
  actionType: 'MCP', toolName: 'x', connectorId: null, isEnabled: true, requiresApproval: false, ...over,
});
const catalog = (provider: string, allowedTools: string[] = []): ConnectorInput =>
  ({ provider, mcpServerUrl: `https://${provider}.example`, allowedTools, connectorId: null, accessMode: null, customTools: null });
const nodes = (provider: string): ConnectorInput => ({ ...catalog(provider), scope: 'nodes' });

describe('providerOfAction', () => {
  it('reads the tool node connector key, defaulting MCP to the Salesforce Platform server', () => {
    expect(providerOfAction({ actionType: 'MCP', connectorId: 'salesforce_metadata' })).toBe('salesforce_metadata');
    expect(providerOfAction({ actionType: 'MCP', connectorId: '' })).toBe('salesforce_mcp');
    expect(providerOfAction({ actionType: 'Apex', connectorId: null })).toBe('salesforce_mcp');
    expect(providerOfAction({ actionType: 'Prebuilt', connectorId: null })).toBeNull();
  });
});

describe('mergeActionsIntoConnectors — strict connections from tool nodes', () => {
  const metadata = nodes('salesforce_metadata');
  const platform = nodes('archon_platform');

  it("the router's request carries only its own tool nodes for a server", () => {
    const out = mergeActionsIntoConnectors([metadata, platform], [
      action({ toolName: 'deploy', connectorId: 'salesforce_metadata' }),
      action({ toolName: 'rollback', connectorId: 'salesforce_metadata' }),
    ])!;
    expect(out.map(c => c.provider)).toEqual(['salesforce_metadata']);
    expect(out[0].allowedTools).toEqual(['deploy', 'rollback']);
  });
  it('a node with no tool nodes for a strict server does not see it at all', () => {
    const out = mergeActionsIntoConnectors([metadata, platform], [])!;
    expect(out).toEqual([]);
  });
  it("a specialist's request carries its thirteen, not the server's twenty-nine", () => {
    const names = ['resolve_object', 'resolve_field', 'describe_object', 'validate', 'serialize', 'check_deploy'];
    const out = mergeActionsIntoConnectors([metadata], names.map(n => action({ toolName: n, connectorId: 'salesforce_metadata' })))!;
    expect(out[0].allowedTools).toEqual(names);
  });
  it('disabled tool nodes do not count', () => {
    const out = mergeActionsIntoConnectors([metadata], [action({ toolName: 'deploy', connectorId: 'salesforce_metadata', isEnabled: false })])!;
    expect(out).toEqual([]);
  });
  it('never mutates the input', () => {
    const input = [nodes('salesforce_metadata')];
    mergeActionsIntoConnectors(input, [action({ toolName: 'deploy', connectorId: 'salesforce_metadata' })]);
    expect(input[0].allowedTools).toEqual([]);
  });
});

describe('mergeActionsIntoConnectors — catalog connections keep their semantics', () => {
  it('an unrestricted catalog stays unrestricted and is not dropped', () => {
    const out = mergeActionsIntoConnectors([catalog('salesforce_mcp')], [action({ toolName: 'soqlQuery' })])!;
    expect(out).toHaveLength(1);
    expect(out[0].allowedTools).toEqual([]);
  });
  it("a restricted catalog grows by the node's own tools", () => {
    const out = mergeActionsIntoConnectors([catalog('salesforce_mcp', ['getRecord'])], [action({ toolName: 'soqlQuery' })])!;
    expect(out[0].allowedTools).toEqual(['getRecord', 'soqlQuery']);
  });
  it('Apex and Flow actions become custom tools on the Salesforce Platform server', () => {
    const out = mergeActionsIntoConnectors([catalog('salesforce_mcp')], [action({ actionType: 'Flow', toolName: 'Create_Lead', name: 'Create Lead' })])!;
    expect(out[0].customTools).toEqual([{ type: 'flow', name: 'Create_Lead', label: 'Create Lead' }]);
  });
  it('no actions and no strict connections returns the input untouched', () => {
    const input = [catalog('gmail', ['send'])];
    expect(mergeActionsIntoConnectors(input, [])).toBe(input);
  });
  it('a catalog and a strict connection can coexist', () => {
    const out = mergeActionsIntoConnectors([catalog('salesforce_mcp'), nodes('salesforce_metadata')], [
      action({ toolName: 'soqlQuery' }),
      action({ toolName: 'deploy', connectorId: 'salesforce_metadata' }),
    ])!;
    expect(out.map(c => [c.provider, c.allowedTools])).toEqual([['salesforce_mcp', []], ['salesforce_metadata', ['deploy']]]);
  });
});

describe('continuationMessage', () => {
  it('names the tool and carries the result, trimmed', () => {
    const m = continuationMessage({ toolName: 'deploy', resultText: 'x'.repeat(5000) });
    expect(m.startsWith('[Approved action executed] deploy: ')).toBe(true);
    expect(m).toContain('…');
    expect(m).toContain('Continue from where you left off');
  });
});

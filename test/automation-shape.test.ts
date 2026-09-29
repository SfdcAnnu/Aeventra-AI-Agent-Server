import { describe, it, expect } from 'vitest';
import { repeatedBranchTails, flowUsesAgent, type FlowStep } from '../src/architect/flow';
import type { AgentSpec } from '../src/architect/spec';

/**
 * The shape of a generated automation, checked the same way for every
 * agent: a step every outcome needs goes once after the rule chain, an
 * automation of steps only carries no unused agent tools, and the
 * Salesforce tool list holds only Salesforce tools.
 */
const update = { step: 'update_record', object: 'Opportunity', id: '{!deal.Id}', fields: { NextStep: 'Reviewed' } } as const;
const task = (subject: string) => ({ step: 'create_task', subject } as const);

describe('repeatedBranchTails', () => {
  it('finds a step copied into every rule of a chain and missing where no rule matches', () => {
    const chain: FlowStep[] = [{
      step: 'if', condition: '{!a} == 1', then: [task('A'), update], else: [{
        step: 'if', condition: '{!b} == 1', then: [task('B'), update], else: [{
          step: 'if', condition: '{!c} == 1', then: [task('C'), update],
        }],
      }],
    }];
    const notes = repeatedBranchTails([{ step: 'loop', over: '{!deals.records}', as: 'deal', body: chain }]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/ends 3 of the 3 branches/);
    expect(notes[0]).toMatch(/no rule matches does not have it/);
  });

  it('stays quiet when the step is already once after the if, or the branches differ', () => {
    expect(repeatedBranchTails([{ step: 'if', condition: '{!a} == 1', then: [task('A')], else: [task('B')] }, update])).toEqual([]);
    expect(repeatedBranchTails([{ step: 'if', condition: '{!a} == 1', then: [task('A')], else: [task('A')] }])).toHaveLength(1);
  });
});

describe('automations made only of steps', () => {
  const spec = (flow: FlowStep[]): AgentSpec => ({
    specVersion: '1.0', name: 'Shape test', department: 'Sales', trigger: { type: 'manual' },
    nodes: [
      { id: 'root', type: 'agent', label: 'Root', instructions: 'a very long prompt' },
      { id: 'tool_query', type: 'tool', label: 'Query', action: { kind: 'mcp', toolName: 'soqlQuery', connector: 'salesforce_mcp', discovered: true } },
      { id: 'tool_send', type: 'tool', label: 'Send', action: { kind: 'mcp', toolName: 'sendEmail', connector: 'gmail', discovered: true } },
    ],
    edges: [{ from: 'root', to: 'tool_query', mode: 'static' }, { from: 'root', to: 'tool_send', mode: 'static' }],
    budgets: { maxSteps: 5, maxCostUsd: 1, timeoutSeconds: 60 }, flow,
  } as unknown as AgentSpec);

  it('keeps only the agent node, with a fixed line, when no step calls the agent', async () => {
    const { pruneForSteps } = await import('../src/architect/flow');
    const s = spec([{ step: 'query_records', soql: 'SELECT Id FROM Account', as: 'rows' }]);
    expect(flowUsesAgent(s.flow)).toBe(false);
    expect(pruneForSteps(s, 'automation')).toMatch(/2 left out/);
    expect(s.nodes.map(n => n.id)).toEqual(['root']);
    expect(s.edges).toEqual([]);
    expect(s.nodes[0].instructions).toMatch(/runs as the steps on its canvas/);
    expect(pruneForSteps(s, 'automation')).toBeNull();
  });

  it('leaves the agent and its tools when a step calls it, or for chat and both', async () => {
    const { pruneForSteps } = await import('../src/architect/flow');
    const withAgent = spec([{ step: 'if', condition: '{!recordId} is not blank', then: [{ step: 'agent' }] }]);
    expect(flowUsesAgent(withAgent.flow)).toBe(true);
    expect(pruneForSteps(withAgent, 'automation')).toBeNull();
    expect(withAgent.nodes).toHaveLength(3);
    const both = spec([{ step: 'query_records', soql: 'SELECT Id FROM Account', as: 'rows' }]);
    expect(pruneForSteps(both, 'both')).toBeNull();
    expect(both.nodes).toHaveLength(3);
  });

  it('puts only Salesforce tools in the auto-added Salesforce tool list', async () => {
    const { compileSpec } = await import('../src/architect/compiler');
    let nodes: Array<Record<string, unknown>> = [];
    const conn = {
      query: async (q: string) => (q.includes('AiEngineConnection__c') ? { records: [{ EngineType__c: 'gpt4', DefaultModel__c: 'gpt-5.5' }] } : { records: [] }),
      sobject: (name: string) => ({
        describe: async () => ({ fields: [] }),
        insert: async (rows: unknown) => {
          if (name === 'AgentDefinition__c') return { success: true, id: 'a01' };
          nodes = rows as Array<Record<string, unknown>>;
          return (rows as unknown[]).map(() => ({ success: true }));
        },
      }),
    };
    const s = spec([]);
    delete (s as { flow?: unknown }).flow;
    (s.nodes[0] as { model?: unknown }).model = { tier: 'large' };
    (s.nodes[1] as { description?: string }).description = 'Query records';
    (s.nodes[2] as { description?: string }).description = 'Send an email';
    (s.nodes[1] as { inputs?: unknown[] }).inputs = [];
    (s.nodes[2] as { inputs?: unknown[] }).inputs = [];
    await compileSpec(s, { conn: conn as never, orgId: 'org', executeType: 'Chat' });
    const catalog = nodes.find(n => n.NodeType__c === 'catalog')!;
    expect(JSON.parse(String(catalog.ConfigJson__c)).allowedTools).toEqual(['soqlQuery']);
  });
});

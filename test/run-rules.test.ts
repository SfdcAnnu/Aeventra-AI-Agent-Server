import { describe, it, expect } from 'vitest';
import { AUTOMATION_RUN_RULES, RUN_RULES_MARKER, withRunRules } from '../src/architect/run-rules';
import type { AgentSpec } from '../src/architect/spec';

/**
 * Every automation agent the builder saves runs by the same rules: check
 * live data on every run, count after writing, use the requirement's
 * words, write the summary last. They are added at save time, once.
 */
describe('withRunRules', () => {
  it('adds the rules once, after the agent\'s own instructions', () => {
    const once = withRunRules('Do the handoff.');
    expect(once.startsWith('Do the handoff.')).toBe(true);
    expect(once).toContain(AUTOMATION_RUN_RULES);
    expect(withRunRules(once)).toBe(once);
  });

  it('says what the measured failures needed', () => {
    expect(AUTOMATION_RUN_RULES).toMatch(/Never treat a Description, a summary/);
    expect(AUTOMATION_RUN_RULES).toMatch(/COUNT AFTER YOU WRITE/);
    expect(AUTOMATION_RUN_RULES).toMatch(/USE THE REQUIREMENT'S WORDS/);
    expect(AUTOMATION_RUN_RULES).toMatch(/WRITE THE SUMMARY LAST/);
  });
});

describe('the compiler adds them to automation agents only', () => {
  const fake = () => {
    const written: { nodes?: Array<Record<string, unknown>> } = {};
    const conn = {
      query: async (soql: string) => (soql.includes('AiEngineConnection__c') ? { records: [{ EngineType__c: 'gpt4', DefaultModel__c: 'gpt-5.5' }] } : { records: [] }),
      sobject: (name: string) => ({
        describe: async () => ({ fields: [] }),
        insert: async (rows: unknown) => {
          if (name === 'AgentDefinition__c') return { success: true, id: 'a01' };
          written.nodes = rows as Array<Record<string, unknown>>;
          return (rows as unknown[]).map(() => ({ success: true }));
        },
      }),
    };
    return { conn, written };
  };
  const spec = (): AgentSpec => ({
    specVersion: '1.0', name: 'Rules test', department: 'Sales', trigger: { type: 'manual' },
    nodes: [{ id: 'root', type: 'agent', label: 'Root', instructions: 'Follow up on the deals.', model: { tier: 'large' } }],
    edges: [], budgets: { maxSteps: 8, maxCostUsd: 1, timeoutSeconds: 60 },
  } as AgentSpec);
  const rootPrompt = (nodes: Array<Record<string, unknown>> | undefined) =>
    String(JSON.parse(String(nodes!.find(n => n.NodeType__c === 'ai')!.ConfigJson__c)).systemPrompt);

  it('for Trigger and Both', async () => {
    const { compileSpec } = await import('../src/architect/compiler');
    for (const executeType of ['Trigger', 'Both'] as const) {
      const { conn, written } = fake();
      await compileSpec(spec(), { conn: conn as never, orgId: 'org', executeType });
      expect(rootPrompt(written.nodes)).toContain(RUN_RULES_MARKER);
    }
  });

  it('not for a chat agent', async () => {
    const { compileSpec } = await import('../src/architect/compiler');
    const { conn, written } = fake();
    await compileSpec(spec(), { conn: conn as never, orgId: 'org', executeType: 'Chat' });
    expect(rootPrompt(written.nodes)).toBe('Follow up on the deals.');
  });
});

describe('AI steps get a real model when saved', () => {
  it('resolves the tier to one of the org\'s models and adds the step system prompt', async () => {
    const { compileSpec, AI_STEP_SYSTEM_PROMPT } = await import('../src/architect/compiler');
    const written: { nodes?: Array<Record<string, unknown>> } = {};
    const conn = {
      query: async (soql: string) => (soql.includes('AiEngineConnection__c') ? { records: [{ EngineType__c: 'gpt4', DefaultModel__c: 'gpt-5.5', AvailableModelsJson__c: '["gpt-5.5","gpt-4.1","gpt-4.1-mini"]' }] } : { records: [] }),
      sobject: (name: string) => ({
        describe: async () => ({ fields: [] }),
        insert: async (rows: unknown) => {
          if (name === 'AgentDefinition__c') return { success: true, id: 'a01' };
          written.nodes = rows as Array<Record<string, unknown>>;
          return (rows as unknown[]).map(() => ({ success: true }));
        },
      }),
    };
    const spec = {
      specVersion: '1.0', name: 'Triage', department: 'Service', trigger: { type: 'manual' },
      nodes: [{ id: 'root', type: 'agent', label: 'Root', instructions: 'x', model: { tier: 'large' } }], edges: [],
      budgets: { maxSteps: 8, maxCostUsd: 1, timeoutSeconds: 60 },
      flow: [{ step: 'ai', as: 'triage', prompt: 'Classify {!recordId}', outputs: { category: 'choice: a | b' }, tier: 'small' }],
    } as unknown as AgentSpec;
    await compileSpec(spec, { conn: conn as never, orgId: 'org', executeType: 'Trigger' });
    const step = written.nodes!.find(n => n.Name === 'AI: triage')!;
    const cfg = JSON.parse(String(step.ConfigJson__c));
    expect(step.NodeType__c).toBe('ai');
    expect(step.NodeSubType__c).toBe('gpt4');
    expect(cfg.model).toBe('gpt-4.1-mini');
    expect(cfg.systemPrompt).toBe(AI_STEP_SYSTEM_PROMPT);
    expect(cfg.outputs[0]).toMatchObject({ name: 'category', type: 'choice' });
  });
});

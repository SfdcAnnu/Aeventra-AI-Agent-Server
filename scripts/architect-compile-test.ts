/**
 * Compiler integration test against the real org (auth via SF_ACCESS_TOKEN
 * / SF_INSTANCE_URL from the sf CLI). Creates a throwaway Draft agent,
 * verifies every compiler invariant on the actual records, then deletes
 * the test agent. No model calls.
 */
import jsforce from 'jsforce';
import { compileSpec, CompileError } from '../src/architect/compiler';
import type { AgentSpec } from '../src/architect/spec';

const sample: AgentSpec = {
  specVersion: '1.0',
  name: 'Compiler Smoke Test',
  department: 'Support',
  description: 'Throwaway agent created by the Phase-1 compiler test.',
  trigger: { type: 'manual' },
  budgets: { maxSteps: 20, maxCostUsd: 0.5, timeoutSeconds: 60 },
  lifecycle: { state: 'blocked', version: 1 },
  nodes: [
    {
      id: 'root',
      type: 'agent',
      label: 'Smoke Root',
      model: { tier: 'medium', style: 'balanced', effort: 'standard', maxOutputTokens: 512 },
      instructions: 'You answer questions about accounts.',
    },
    {
      id: 'lookup_helper',
      type: 'subagent',
      label: 'Lookup Helper',
      description: 'Use when the customer asks about account details that need a database lookup.',
      model: { tier: 'small' },
      instructions: 'Look up the requested account facts and return them.',
      returns: { type: 'object', properties: { answer: { type: 'string' } } },
    },
    {
      id: 'create_case',
      type: 'tool',
      label: 'Create a case',
      description: 'Use when the customer reports a problem that needs the support team.',
      action: { kind: 'crud', sobject: 'Case', operation: 'create', discovered: true, sideEffect: true },
      approval: { required: true },
      inputs: [
        { name: 'sobjectType', required: true, source: 'literal', value: 'Case' },
        { name: 'Subject', required: true, source: 'model', value: 'a short summary of the issue' },
      ],
    },
  ],
  edges: [
    { from: 'root', to: 'lookup_helper', mode: 'call', contextPolicy: 'isolated' },
    { from: 'root', to: 'create_case', mode: 'static' },
  ],
  prerequisites: [
    {
      id: 'PRE-001',
      kind: 'permission',
      title: 'Let the agent create cases',
      why: 'The integration user cannot create Case records yet.',
      steps: ['Setup → Permission Sets → grant Create on Case'],
      assignee: 'salesforce_admin',
      blocking: true,
      status: 'pending',
      affects: ['create_case'],
      estimatedEffort: 'minutes',
    },
  ],
  architecture: {
    splitRationale: [
      { question: 'context', answer: false, evidence: 'a handful of account fields per turn' },
      { question: 'permission', answer: true, evidence: 'lookups run separately from case-writing scope' },
      { question: 'independence', answer: false, evidence: 'no adversarial check needed here' },
      { question: 'toolCount', answer: false, evidence: '2 tools total' },
    ],
    subAgentCount: 1,
    maxNesting: 2,
  },
};

async function main() {
  const conn = new jsforce.Connection({
    accessToken: process.env.SF_ACCESS_TOKEN,
    instanceUrl: process.env.SF_INSTANCE_URL,
  });

  // Compile.
  const result = await compileSpec(sample, { conn, orgId: 'compile-test' });
  console.log('COMPILED:', JSON.stringify({ ...result, notes: result.notes }, null, 1));

  const fail = (msg: string): never => {
    throw new Error('INVARIANT FAILED: ' + msg);
  };

  // Verify the records.
  const def = (
    await conn.query<{ Id: string; Status__c: string; ExecuteType__c: string; CanvasJson__c: string; SetupChecklistJson__c: string }>(
      `SELECT Id, Status__c, ExecuteType__c, CanvasJson__c, SetupChecklistJson__c FROM AgentDefinition__c WHERE Id = '${result.agentId}'`,
    )
  ).records[0];
  if (def.Status__c !== 'Draft') fail(`blocked spec produced Status ${def.Status__c} — must be Draft`);
  if (def.ExecuteType__c !== 'Chat') fail('ExecuteType must be Chat');
  const canvas = JSON.parse(def.CanvasJson__c) as { connections: Array<{ fromPort: string; toPort: string }> };
  if (!canvas.connections.every(c => c.fromPort === 'tool' && c.toPort === 'in')) {
    fail('every connection must use fromPort tool / toPort in — the runtime reads nothing else');
  }
  const checklist = JSON.parse(def.SetupChecklistJson__c) as Array<{ id: string; blocking: boolean }>;
  if (checklist.length !== 1 || checklist[0].id !== 'PRE-001' || checklist[0].blocking !== true) {
    fail('prerequisite did not land in the setup checklist');
  }

  const nodes = (
    await conn.query<{ Name: string; NodeType__c: string; IsEnabled__c: boolean; ConfigJson__c: string }>(
      `SELECT Name, NodeType__c, IsEnabled__c, ConfigJson__c FROM AgentNode__c WHERE AgentDefinition__c = '${result.agentId}' ORDER BY SortOrder__c`,
    )
  ).records;
  if (nodes.length !== 4) fail(`expected 4 nodes (ai, subagent, tool, auto-injected catalog) — got ${nodes.length}`);
  const toolNode = nodes.find(n => n.NodeType__c === 'tool')!;
  if (toolNode.IsEnabled__c !== false) fail('blocked tool node must compile disabled');
  const toolCfg = JSON.parse(toolNode.ConfigJson__c) as Record<string, unknown>;
  if (toolCfg.requiresApproval !== true) fail('approval.required must compile to requiresApproval');
  if (toolCfg.toolName !== 'createSobjectRecord') fail('crud create must map to createSobjectRecord');
  if (toolCfg.blockedByPrerequisite !== 'PRE-001') fail('blocked node must link its prerequisite id');
  const catalog = nodes.find(n => n.NodeType__c === 'catalog')!;
  const catCfg = JSON.parse(catalog.ConfigJson__c) as { provider: string; allowedTools: string[] };
  if (catCfg.provider !== 'salesforce_mcp' || !catCfg.allowedTools.includes('createSobjectRecord')) {
    fail('auto-injected Salesforce catalog missing or incomplete');
  }
  console.log('RECORD INVARIANTS: all pass (Draft status, fromPort wiring, blocked node disabled+linked, approval flag, auto catalog)');

  // The activation guard: publishing while blocked must throw.
  const published = JSON.parse(JSON.stringify(sample)) as AgentSpec;
  published.lifecycle = { state: 'published', version: 2 };
  let threw = false;
  try {
    await compileSpec(published, { conn, orgId: 'compile-test', existingAgentId: result.agentId });
  } catch (e) {
    threw = e instanceof Error && /blocking prerequisite/.test(e.message);
  }
  if (!threw) fail('publishing with an open blocking prerequisite must be refused');
  console.log('ACTIVATION GUARD: publish-while-blocked correctly refused');

  // Cleanup the throwaway records.
  const nodeIds = (await conn.query<{ Id: string }>(`SELECT Id FROM AgentNode__c WHERE AgentDefinition__c = '${result.agentId}'`)).records.map(r => r.Id);
  if (nodeIds.length) await conn.sobject('AgentNode__c').destroy(nodeIds);
  await conn.sobject('AgentDefinition__c').destroy(result.agentId);
  console.log('CLEANUP: test agent deleted');
  console.log('\nCOMPILER INTEGRATION TEST PASSES');
}

main().catch(e => {
  console.error(e instanceof CompileError ? 'COMPILE ERROR: ' + e.message : e);
  process.exit(1);
});

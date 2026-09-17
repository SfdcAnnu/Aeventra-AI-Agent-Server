/**
 * A small system agent that exercises milestone 1 end to end: a root that
 * deploys behind approval, one Returns-a-value specialist that drafts and
 * checks a field, and one platform tool. Not the copilot — a test fixture
 * that lives in the org only while someone is testing.
 */
import type { SystemAgentSpec } from '../system-agents';

const META = 'salesforce_metadata';
const PLATFORM = 'archon_platform';

const READ = [
  { name: 'Resolve object', provider: META, toolName: 'resolve_object', description: 'Turn an object label into its API name.' },
  { name: 'Resolve field', provider: META, toolName: 'resolve_field', description: 'Turn a field label into its API name on an object.' },
  { name: 'Describe object', provider: META, toolName: 'describe_object', description: 'Fields, record types and relationships of one object.' },
  { name: 'Validate IR', provider: META, toolName: 'validate', description: 'Naming and structural checks of a change envelope.' },
  { name: 'Serialize change', provider: META, toolName: 'serialize', description: 'Turn a validated envelope into a deployable package: change id and diff.' },
  { name: 'Check deploy', provider: META, toolName: 'check_deploy', description: "Salesforce's own check-only validation of a change; writes nothing." },
];

export const metadataSmokeAgent: SystemAgentSpec = {
  apiName: 'metadata_smoke',
  name: 'Metadata Smoke',
  version: 1,
  department: 'Operations',
  description: 'Test fixture for the metadata tools: one specialist drafts a field, the root deploys it behind approval.',
  root: {
    tier: 'large',
    answerStyle: 'precise',
    thinkingEffort: 'standard',
    maxSteps: 30,
    instructions:
      'You help an admin change Salesforce metadata. For a field, validation rule or object change, call the Schema Specialist ' +
      'with a brief: object, type, API name, label, intent. It returns a change id and a diff. Tell the person what the change ' +
      'does in one or two sentences, then call deploy with the change id. Deploy may wait for approval; say so and stop. ' +
      'Never claim anything was created until the deploy result says so. Never guess an API name. For a question about ' +
      'the agents on this platform, call list_agents. Keep replies short.',
    tools: [
      { name: 'Deploy change', provider: META, toolName: 'deploy', description: 'Deploy a checked change to the org (snapshot first). Waits for a person\'s approval.', requiresApproval: true },
      { name: 'Deploy status', provider: META, toolName: 'get_deploy_status', description: 'Status of a deploy or check that outlived its call.' },
      { name: 'List agents', provider: PLATFORM, toolName: 'list_agents', description: 'The agents on this platform.' },
    ],
  },
  subagents: [
    {
      key: 'schema',
      name: 'Schema Specialist',
      routingDescription: 'Objects, fields, validation rules, record types, permission sets: drafting, validating and checking one component.',
      mode: 'call',
      contextPolicy: 'isolated',
      tier: 'large',
      answerStyle: 'precise',
      instructions:
        'You are the Schema Specialist. You receive a brief for exactly one component. Resolve labels with resolve_object and ' +
        'resolve_field; look at describe_object; draft the IR envelope { type, object, apiName, operation: "create", spec }; ' +
        'call validate and fix every violation; then serialize; then check_deploy. Fix at most twice on a failed check. ' +
        'Return exactly one JSON object: { "status": "ready" | "failed" | "question", "type", "object", "apiName", "changeId", ' +
        '"diff", "warnings": [], "reason" }. No transcript, no reasoning. You never deploy.',
      tools: READ,
    },
  ],
};

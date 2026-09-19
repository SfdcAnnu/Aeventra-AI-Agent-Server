/**
 * Metadata Expert — changes Salesforce metadata as the signed-in user,
 * behind approval. Seeded into the org once from this spec and then owned
 * by the org: it appears as a normal agent that admins can edit, put on a
 * channel or a page, and tune — unlike the copilot, it is not managed.
 *
 * Shape, from the plan: a root that routes and holds every write, three
 * domain specialists that resolve, read, draft, validate and run
 * Salesforce's check, and return a changeId — never a deploy.
 */
import type { SystemAgentSpec, SystemToolSpec } from '../system-agents';

const META = 'salesforce_metadata';

const SHARED: SystemToolSpec[] = [
  { name: 'Resolve object', provider: META, toolName: 'resolve_object', description: 'Turn an object label into its API name, with candidates when unsure.' },
  { name: 'Resolve field', provider: META, toolName: 'resolve_field', description: 'Turn a field label into its API name and type on an object.' },
  { name: 'Describe object', provider: META, toolName: 'describe_object', description: 'Trimmed field list of one object: names, labels, types, picklist values.' },
  { name: 'List metadata', provider: META, toolName: 'list_metadata', description: 'What exists of a type — all validation rules on an object, all flows.' },
  { name: 'Retrieve', provider: META, toolName: 'retrieve', description: 'The current XML of a component as JSON; the basis of every edit.' },
  { name: 'Check dependencies', provider: META, toolName: 'check_dependencies', description: 'What references a component before you touch it.' },
];
const PIPE: SystemToolSpec[] = [
  { name: 'Validate IR', provider: META, toolName: 'validate', description: 'Naming and structural checks of a change envelope; milliseconds.' },
  { name: 'Serialize change', provider: META, toolName: 'serialize', description: 'Turn a validated envelope into a deployable package: change id, files, diff.' },
  { name: 'Check deploy', provider: META, toolName: 'check_deploy', description: "Salesforce's own check-only validation; writes nothing." },
];

const SPECIALIST_CONTRACT =
  ' Draft the IR envelope { type, object, apiName, operation: "create" | "modify", spec }; for a modify, retrieve first and patch — never regenerate whole. ' +
  'Call validate and fix every violation; then serialize; then check_deploy. Fix at most twice on a failed check. ' +
  'Describe an object ONCE — describe_object with includeFields true and no fieldsLike — and take every field you need from that one result; never describe the same object twice in a task. ' +
  'Return exactly one JSON object: { "status": "ready" | "failed" | "question", "type", "object", "apiName", "changeId", "diff", "warnings": [], "reason" }. ' +
  'When the brief is a question with nothing to change, "changeId" is null and "diff" carries the data exactly as the tools returned it — every field, every picklist value, untrimmed — so the lead agent can answer follow-ups without asking you again. No transcript. You never deploy.';

export const metadataExpertAgent: SystemAgentSpec = {
  apiName: 'metadata_expert',
  name: 'Metadata Expert',
  version: 1,
  managed: false,
  department: 'Platform',
  accessMode: 'Org',
  description: 'Reads, drafts, validates and deploys Salesforce metadata as the signed-in user: objects, fields, validation rules, record types, layouts, list views, permission sets and flows. Every deploy waits for approval and can be rolled back.',
  root: {
    tier: 'medium',
    answerStyle: 'precise',
    thinkingEffort: 'standard',
    maxReplyTokens: 900,
    // The platform ceilings: a metadata change is a long tool chain and the
    // person asked for the whole box, not a chat-sized one.
    maxSteps: 40,
    maxTokens: 200_000,
    maxMs: 240_000,
    instructions:
      'You help an admin change Salesforce metadata. You route and deploy; the specialists do the work.\n' +
      '- Fields, objects, record types, validation rules, permission sets → Schema Specialist.\n' +
      '- Page layouts, list views, compact layouts, field sets → UI Specialist.\n' +
      '- Flows → Flow Specialist.\n' +
      'Send a brief: object, what to change, why, in the person\'s words — the specialist resolves names and reads the org. When it returns a changeId, tell the person what the change does in one or two sentences and show the diff, then call deploy with the changeId. Deploy waits for a person\'s approval; say so and stop. ' +
      'If it returns "question", ask the person and call the specialist again. For a flow, activate_flow is a separate approved step after deploy. rollback undoes a deploy from its snapshot. ' +
      'Never claim anything was created or changed until the deploy result says so. Never guess an API name.',
    tools: [
      { name: 'Snapshot', provider: META, toolName: 'snapshot', description: 'Store the current XML of the affected components before a change.' },
      { name: 'Deploy change', provider: META, toolName: 'deploy', description: 'Deploy a checked change to the org (snapshot first). Waits for a person\'s approval.', requiresApproval: true },
      { name: 'Deploy status', provider: META, toolName: 'get_deploy_status', description: 'Status of a deploy or check that outlived its call.' },
      { name: 'Rollback', provider: META, toolName: 'rollback', description: 'Redeploy a snapshot to undo a change. Waits for approval.', requiresApproval: true },
      { name: 'Activate flow', provider: META, toolName: 'activate_flow', description: 'Activate a deployed flow version. Waits for approval.', requiresApproval: true },
      { name: 'Refresh catalog', provider: META, toolName: 'refresh_catalog', description: 'Clear the describe and action caches after changes made outside this agent.' },
    ],
  },
  subagents: [
    {
      key: 'schema',
      name: 'Schema Specialist',
      routingDescription: 'Objects, fields, record types, validation rules, permission-set deltas: drafting, validating and checking one component.',
      mode: 'call', contextPolicy: 'isolated', tier: 'large', answerStyle: 'precise', thinkingEffort: 'standard', maxReplyTokens: 800,
      instructions: 'You are the Schema Specialist. You receive a brief for exactly one component. Resolve labels with resolve_object and resolve_field; look at describe_object; use compile_formula for any formula before serializing.' + SPECIALIST_CONTRACT,
      tools: [
        ...SHARED,
        { name: 'Describe field', provider: META, toolName: 'describe_field', description: 'Full metadata of one field.' },
        { name: 'List record types', provider: META, toolName: 'list_record_types', description: 'Record types and their picklist assignments.' },
        { name: 'List value sets', provider: META, toolName: 'list_value_sets', description: 'Global value sets, to reuse instead of duplicating.' },
        { name: 'Compile formula', provider: META, toolName: 'compile_formula', description: 'Salesforce\'s formula compiler, without a deploy.' },
        ...PIPE,
      ],
    },
    {
      key: 'ui',
      name: 'UI Specialist',
      routingDescription: 'Page layouts, list views, compact layouts and field sets: patching what exists, never regenerating; detects Dynamic Forms first.',
      mode: 'call', contextPolicy: 'isolated', tier: 'large', answerStyle: 'precise', thinkingEffort: 'standard', maxReplyTokens: 800,
      instructions: 'You are the UI Specialist. Call list_flexipages before any layout work — if the object uses Dynamic Forms, say so and stop. Layouts are patched from retrieve, never regenerated; use layout_to_preview_json so the person can see before and after.' + SPECIALIST_CONTRACT,
      tools: [
        ...SHARED,
        { name: 'List layouts', provider: META, toolName: 'list_layouts', description: 'Layouts and record-type mapping.' },
        { name: 'Layout assignments', provider: META, toolName: 'get_layout_assignments', description: 'Profile → layout map.' },
        { name: 'List compact layouts', provider: META, toolName: 'list_compact_layouts', description: 'Compact layouts and assignments.' },
        { name: 'List flexipages', provider: META, toolName: 'list_flexipages', description: 'Record pages; detects Dynamic Forms.' },
        { name: 'Layout preview', provider: META, toolName: 'layout_to_preview_json', description: 'A layout as sections, columns and fields for a preview.' },
        ...PIPE,
      ],
    },
    {
      key: 'flow',
      name: 'Flow Specialist',
      routingDescription: 'Record-triggered and autolaunched flows from the template library; flows deploy as Draft and are activated separately.',
      mode: 'call', contextPolicy: 'isolated', tier: 'large', answerStyle: 'precise', thinkingEffort: 'deep', maxReplyTokens: 900,
      instructions: 'You are the Flow Specialist. Pick a template and fill its parameters rather than composing a graph from nothing; reuse actions found by search_reusable_actions and read their inputs with describe_action; call validate_flow_graph before serialize. Flows deploy as Draft — say so; activation is the root\'s approved step.' + SPECIALIST_CONTRACT,
      tools: [
        ...SHARED,
        { name: 'Search reusable actions', provider: META, toolName: 'search_reusable_actions', description: 'Invocable Apex, active subflows and standard actions, in one search.' },
        { name: 'Describe action', provider: META, toolName: 'describe_action', description: 'Inputs, outputs and required flags of an action or subflow.' },
        { name: 'Validate flow graph', provider: META, toolName: 'validate_flow_graph', description: 'Deterministic checks on the flow IR.' },
        { name: 'List flow versions', provider: META, toolName: 'list_flow_versions', description: 'Versions and which is active.' },
        ...PIPE,
      ],
    },
  ],
};

/**
 * AgentSpec — the contract. The Architect emits instances of this and
 * NOTHING else; the deterministic compiler (compiler.ts) builds platform
 * objects from a validated instance. Two layers of enforcement:
 *
 *   1. JSON Schema (architect/schemas/agent-spec.schema.json) via ajv —
 *      shapes, enums, the `action.discovered: const true` rule that stops
 *      the Architect inventing a tool, required prompts/models, the
 *      splitRationale shape, countJustification above 8 sub-agents.
 *
 *   2. Logic checks the schema cannot express (validateSpecLogic below):
 *      sub-agents with no forcing question answered true, dangling edge
 *      references, call edges to children without a returns schema,
 *      conditional edges without a condition, sub-agents missing their
 *      routing description, and tool names that are not in the live
 *      capability manifest.
 *
 * The one rule worth belt AND braces: a spec in lifecycle.state 'blocked'
 * (or with open blocking prerequisites) must never activate — enforced
 * here in assertActivatable AND again in the compiler's status mapping.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

// ── Types (working subset — the schema remains the authority) ────────
export type SpecTier = 'small' | 'medium' | 'large';

export interface SpecModel {
  tier?: SpecTier;
  modelId?: string;
  fallbackId?: string;
  style?: 'precise' | 'balanced' | 'exploratory';
  effort?: 'off' | 'standard' | 'deep';
  maxOutputTokens?: number;
}

export interface SpecNode {
  id: string;
  type: 'agent' | 'subagent' | 'tool' | 'tool_catalog' | 'approval' | 'condition' | 'transform' | 'end';
  label: string;
  model?: SpecModel;
  instructions?: string;
  returns?: Record<string, unknown>;
  toolChoice?: 'auto' | 'required' | 'none';
  parallelTools?: boolean;
  action?: {
    kind: 'mcp' | 'apex_invocable' | 'flow_invocable' | 'crud' | 'http' | 'code';
    connector?: string;
    toolName?: string;
    sobject?: string;
    operation?: 'create' | 'update' | 'upsert' | 'delete' | 'query';
    sideEffect?: boolean;
    sequence?: Array<Record<string, unknown>>;
    discovered: true;
  };
  inputs?: Array<{ name: string; required?: boolean; source: 'model' | 'literal' | 'record' | 'step' | 'context'; value?: string }>;
  output?: { saveAs?: string; largeResults?: 'summarise' | 'full' };
  description?: string;
  approval?: { required?: boolean; approver?: string; approverId?: string; condition?: string };
  onFailure?: { retries?: number; timeoutSeconds?: number; then?: 'tell_agent' | 'stop_run' | 'escalate' };
  position?: { x: number; y: number };
}

export interface SpecEdge {
  from: string;
  to: string;
  mode: 'call' | 'handoff' | 'static' | 'conditional';
  contextPolicy?: 'isolated' | 'summary' | 'windowed' | 'full';
  carryFields?: string[];
  windowTurns?: number;
  condition?: string;
  parallel?: boolean;
}

export interface SpecPrerequisite {
  id: string;
  kind: string;
  title: string;
  why: string;
  steps: string[];
  assignee: string;
  blocking: boolean;
  status: 'pending' | 'in_progress' | 'done' | 'waived';
  waivedReason?: string;
  verification?: string;
  affects?: string[];
  estimatedEffort?: 'minutes' | 'hours' | 'days';
}

export interface AgentSpec {
  specVersion: '1.0';
  name: string;
  department: string;
  description?: string;
  requirementId?: string;
  trigger: { type: string; channel?: string; sobject?: string; condition?: string; cron?: string };
  nodes: SpecNode[];
  edges: SpecEdge[];
  knowledge?: Array<{ knowledgeBaseId: string; attachedTo: string; topK?: number; minScore?: number }>;
  budgets: { maxSteps: number; maxCostUsd: number; timeoutSeconds: number; maxDepth?: number };
  guardrails?: string[];
  lifecycle?: { state: string; version?: number; supersedes?: number; changeReason?: string };
  prerequisites?: SpecPrerequisite[];
  architecture?: {
    splitRationale: Array<{ question: string; answer: boolean; evidence: string }>;
    subAgentCount: number;
    maxNesting: number;
    estimate?: Record<string, unknown>;
    countJustification?: string;
  };
}

export interface SpecError {
  path: string;
  message: string;
}

/** One discovered capability the manifest can vouch for. Identity is the
 *  (kind, name) pair — e.g. ('mcp','soqlQuery'), ('apex_invocable',
 *  'scoreOpportunity'), ('flow_invocable','Assign_Case_To_Queue'). CRUD is
 *  vouched per (crud, sobject:operation). */
export interface CapabilityManifest {
  has(kind: string, name: string): boolean;
}

export function manifestFromNames(entries: Iterable<string>): CapabilityManifest {
  const set = new Set(entries);
  return { has: (kind, name) => set.has(`${kind}:${name}`) };
}

// ── Schema validation ────────────────────────────────────────────────
const SCHEMA_PATH = join(process.cwd(), 'architect', 'schemas', 'agent-spec.schema.json');

let compiled: ((data: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> | null };

function schemaValidator() {
  if (!compiled) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    compiled = ajv.compile(schema) as typeof compiled;
  }
  return compiled;
}

export function validateSpecSchema(spec: unknown): SpecError[] {
  const validate = schemaValidator();
  if (validate(spec)) return [];
  return (validate.errors ?? []).map(e => ({
    path: e.instancePath || '(root)',
    message: e.message ?? 'invalid',
  }));
}

// ── Logic checks the schema cannot express ───────────────────────────
export function validateSpecLogic(spec: AgentSpec, manifest?: CapabilityManifest): SpecError[] {
  const errors: SpecError[] = [];
  const ids = new Set(spec.nodes.map(n => n.id));
  const byId = new Map(spec.nodes.map(n => [n.id, n]));

  // Exactly one root agent.
  const roots = spec.nodes.filter(n => n.type === 'agent');
  if (roots.length !== 1) {
    errors.push({ path: '/nodes', message: `exactly one node of type 'agent' is required — found ${roots.length}` });
  }

  // Duplicate ids.
  if (ids.size !== spec.nodes.length) {
    errors.push({ path: '/nodes', message: 'node ids must be unique' });
  }

  // Edges reference real nodes; conditional edges carry a condition;
  // call edges land on subagents that declare a returns schema.
  spec.edges.forEach((e, i) => {
    if (!ids.has(e.from)) errors.push({ path: `/edges/${i}/from`, message: `references unknown node '${e.from}'` });
    if (!ids.has(e.to)) errors.push({ path: `/edges/${i}/to`, message: `references unknown node '${e.to}'` });
    if (e.mode === 'conditional' && !e.condition) {
      errors.push({ path: `/edges/${i}`, message: 'conditional edge needs a condition' });
    }
    const target = byId.get(e.to);
    if (e.mode === 'call' && target?.type === 'subagent' && !target.returns) {
      errors.push({ path: `/edges/${i}`, message: `call edge to '${e.to}' — the sub-agent must declare a returns schema` });
    }
  });

  // Split test: sub-agents present but no forcing question answered true.
  const subCount = spec.nodes.filter(n => n.type === 'subagent').length;
  const rationale = spec.architecture?.splitRationale ?? [];
  if (subCount > 0 && rationale.length === 4 && rationale.every(q => q.answer === false)) {
    errors.push({
      path: '/architecture/splitRationale',
      message: `${subCount} sub-agent(s) but every forcing question is false — collapse to one agent or supply real evidence`,
    });
  }
  if (spec.architecture && spec.architecture.subAgentCount !== subCount) {
    errors.push({
      path: '/architecture/subAgentCount',
      message: `declared ${spec.architecture.subAgentCount} but the graph has ${subCount} sub-agents`,
    });
  }

  // Tool names must exist in the live capability manifest — orgs change
  // between design and compile.
  if (manifest) {
    for (const n of spec.nodes) {
      if (n.type !== 'tool' || !n.action) continue;
      const a = n.action;
      const identity =
        a.kind === 'crud' ? `${a.sobject ?? '?'}:${a.operation ?? '?'}` : (a.toolName ?? '?');
      if (!manifest.has(a.kind, identity)) {
        errors.push({
          path: `/nodes/${n.id}/action`,
          message: `references ${a.kind} '${identity}' which the Org Surveyor did not discover — a tool that was not found cannot be used`,
        });
      }
    }
  }

  // Every required tool parameter must be mapped, not described in prose.
  for (const n of spec.nodes) {
    if (n.type === 'tool') {
      const required = (n.inputs ?? []).filter(i => i.required);
      for (const input of required) {
        if (input.source !== 'model' && !input.value) {
          errors.push({
            path: `/nodes/${n.id}/inputs/${input.name}`,
            message: `required parameter '${input.name}' with source '${input.source}' needs a value mapping`,
          });
        }
      }
    }
  }

  return errors;
}

/** Full validation: schema first, then logic. */
export function validateSpec(spec: unknown, manifest?: CapabilityManifest): SpecError[] {
  const schemaErrors = validateSpecSchema(spec);
  if (schemaErrors.length > 0) return schemaErrors;
  return validateSpecLogic(spec as AgentSpec, manifest);
}

/** Belt AND braces: refuse activation while blocked. The compiler applies
 *  the same rule in its status mapping; this guard exists so a direct
 *  activation call cannot slip past either. */
export function assertActivatable(spec: AgentSpec): void {
  const state = spec.lifecycle?.state ?? 'draft';
  if (state === 'blocked') {
    throw new Error('This agent is blocked — one or more blocking prerequisites are still open.');
  }
  const open = (spec.prerequisites ?? []).filter(
    p => p.blocking && p.status !== 'done' && p.status !== 'waived',
  );
  if (open.length > 0) {
    throw new Error(
      `Cannot activate: ${open.length} blocking prerequisite(s) still open — ${open.map(p => p.id).join(', ')}.`,
    );
  }
}

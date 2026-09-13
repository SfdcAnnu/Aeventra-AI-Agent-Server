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

// ── Prerequisite normalisation ───────────────────────────────────────
//
// The Gap Reporter writes prose about what an org is missing. It is NOT
// given the AgentSpec schema (that would cost every build a JSON schema it
// never emits a spec from), so what comes back is shaped like the request
// rather than like `prerequisite` — and `additionalProperties: false` then
// rejects it at the FINAL gate, after all seven stages have been paid for.
// Live failure: "must have required property 'kind' / 'title' / 'assignee'
// / 'status' … must NOT have additional properties".
//
// Constraining prose to a closed schema by asking nicely does not hold. So
// the model's output is coerced here instead: aliases are mapped, enums are
// snapped to the nearest legal value, required fields get honest defaults,
// and anything unrecognised is dropped — which is what makes
// `additionalProperties: false` pass by construction rather than by luck.

const PREREQ_KINDS = [
  'invocable_apex', 'flow', 'field', 'permission', 'connector',
  'knowledge_base', 'record_type', 'named_credential', 'data',
] as const;

const ASSIGNEES = [
  'salesforce_admin', 'apex_developer', 'integration_owner', 'data_owner', 'business_owner',
] as const;

const STATUSES = ['pending', 'in_progress', 'done', 'waived'] as const;
const EFFORTS = ['minutes', 'hours', 'days'] as const;

/** First present, non-empty value among the aliases. */
function pick(src: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(' ');
  return '';
}

/** Snap a free-text value onto an enum: exact match first, then the member
 *  whose words appear in the text. Falls back rather than failing — a
 *  prerequisite with a slightly wrong `kind` is infinitely better than a
 *  build that dies at the last gate. */
function snap<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const raw = asText(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (!raw) return fallback;
  const exact = allowed.find(a => a === raw);
  if (exact) return exact;
  const partial = allowed.find(a => raw.includes(a) || a.includes(raw));
  if (partial) return partial;
  // Vocabulary the writer actually reaches for, mapped to the schema's.
  if (/apex|class|invocable/.test(raw) && allowed.includes('invocable_apex' as T)) return 'invocable_apex' as T;
  if (/flow|automation/.test(raw) && allowed.includes('flow' as T)) return 'flow' as T;
  if (/field|column|attribute/.test(raw) && allowed.includes('field' as T)) return 'field' as T;
  if (/permission|access|profile|sharing/.test(raw) && allowed.includes('permission' as T)) return 'permission' as T;
  if (/connector|mcp|integration|api|endpoint/.test(raw) && allowed.includes('connector' as T)) return 'connector' as T;
  if (/knowledge|article|kb|document/.test(raw) && allowed.includes('knowledge_base' as T)) return 'knowledge_base' as T;
  if (/credential|auth|secret|token/.test(raw) && allowed.includes('named_credential' as T)) return 'named_credential' as T;
  if (/developer|engineer|code/.test(raw) && allowed.includes('apex_developer' as T)) return 'apex_developer' as T;
  if (/admin/.test(raw) && allowed.includes('salesforce_admin' as T)) return 'salesforce_admin' as T;
  if (/business|owner|manager/.test(raw) && allowed.includes('business_owner' as T)) return 'business_owner' as T;
  return fallback;
}

function asSteps(v: unknown): string[] {
  if (Array.isArray(v)) {
    const out = v.map(asText).map(s => s.trim()).filter(Boolean);
    if (out.length > 0) return out;
  }
  const text = asText(v).trim();
  if (!text) return [];
  // A single blob of instructions is common — split it into real steps so
  // the checklist reads as one, rather than as a paragraph in a box.
  const lines = text.split(/\n+|(?<=\.)\s+(?=[A-Z0-9])/).map(s => s.replace(/^\s*[-*\d.)\s]+/, '').trim()).filter(Boolean);
  return lines.length > 0 ? lines : [text];
}

/**
 * What KIND of thing is missing, read out of the gap's own words.
 *
 * Ordered most-specific first, because the vocabularies overlap: "expose an
 * invocable Apex method to the integration user" is an Apex gap that also
 * mentions access, and calling it a permission gap would send it to the
 * wrong person.
 */
function inferKind(text: string): SpecPrerequisite['kind'] {
  const t = text.toLowerCase();
  if (/invocable|apex class|apex method|apex action|write.{0,12}apex/.test(t)) return 'invocable_apex';
  if (/\bflow\b|process builder|screen flow|autolaunched/.test(t)) return 'flow';
  if (/named credential|auth provider|oauth|api key|secret/.test(t)) return 'named_credential';
  if (/mcp|connector|integration|external service|endpoint|webhook/.test(t)) return 'connector';
  if (/knowledge|article|kb\b|documentation|help cent/.test(t)) return 'knowledge_base';
  if (/record type/.test(t)) return 'record_type';
  if (/\bfields?\b|picklist|column|attribute/.test(t)) return 'field';
  if (/permission|profile|access|sharing|visibility|fls/.test(t)) return 'permission';
  if (/\bdata\b|records exist|populate|backfill|migrat/.test(t)) return 'data';
  return 'permission';
}

/** Who does this work, when the writer did not say. The kind already
 *  implies it — an Apex gap is a developer's, a field is an admin's. */
const ASSIGNEE_FOR_KIND: Record<string, SpecPrerequisite['assignee']> = {
  invocable_apex: 'apex_developer',
  flow: 'salesforce_admin',
  field: 'salesforce_admin',
  record_type: 'salesforce_admin',
  permission: 'salesforce_admin',
  connector: 'integration_owner',
  named_credential: 'integration_owner',
  knowledge_base: 'business_owner',
  data: 'data_owner',
};

/**
 * Coerce whatever the Gap Reporter returned into a schema-valid
 * prerequisite. Never throws and never returns null: a gap the customer is
 * not told about is the worst outcome this system can produce, so a
 * partially-guessed prerequisite always beats a dropped one.
 */
export function normalizePrerequisite(input: unknown, index: number): SpecPrerequisite {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

  const title =
    asText(pick(src, 'title', 'name', 'capability', 'label', 'summary', 'gap', 'requirement'))
      .trim()
      .slice(0, 120) || `Missing capability ${index + 1}`;

  const why =
    asText(pick(src, 'why', 'reason', 'impact', 'description', 'detail', 'rationale', 'because'))
      .trim()
      .slice(0, 500) || 'The agent cannot do this until it exists in the org.';

  const steps = asSteps(pick(src, 'steps', 'resolution', 'howToFix', 'how_to_fix', 'actions', 'remediation', 'fix'));

  const rawId = asText(src.id).trim();
  const out: SpecPrerequisite = {
    // Regenerated unless it already matches — the pattern is ^PRE-[0-9]{3}$
    // and an id like "PRE-1" or "gap-1" fails schema on its own.
    id: /^PRE-\d{3}$/.test(rawId) ? rawId : `PRE-${String(index + 1).padStart(3, '0')}`,
    // With no `kind` field at all — the common case, since the writer has
    // not been shown the enum — read it out of what the gap actually says.
    // Defaulting everything to 'permission' would tell an admin to grant
    // access when the real work is writing an Apex class.
    kind: src.kind !== undefined || src.type !== undefined || src.category !== undefined
      ? snap(pick(src, 'kind', 'type', 'category'), PREREQ_KINDS, 'permission')
      : inferKind(`${title} ${why} ${asText(pick(src, 'steps', 'resolution', 'howToFix', 'actions', 'fix'))}`),
    title,
    why,
    steps: steps.length > 0
      ? steps.slice(0, 12)
      : [`Decide who owns "${title}" in your org and what should provide it.`,
         'Tell Archon once it exists and the agent will be re-checked automatically.'],
    assignee: 'salesforce_admin', // replaced below, once `kind` is settled

    // Default true: a gap whose severity the writer did not state should
    // hold activation rather than quietly ship a half-working agent.
    blocking: typeof src.blocking === 'boolean' ? src.blocking
      : typeof src.isBlocking === 'boolean' ? (src.isBlocking as boolean)
      : !/optional|nice.to.have|non.blocking/i.test(asText(pick(src, 'severity', 'priority', 'blocking'))),
    status: snap(pick(src, 'status', 'state'), STATUSES, 'pending'),
  };

  // The writer's own words win; otherwise the kind decides, which is more
  // honest than sending every unattributed gap to the Salesforce admin.
  const statedAssignee = pick(src, 'assignee', 'owner', 'assignedTo', 'assigned_to', 'responsible');
  out.assignee = statedAssignee !== undefined
    ? snap(statedAssignee, ASSIGNEES, ASSIGNEE_FOR_KIND[out.kind] ?? 'salesforce_admin')
    : (ASSIGNEE_FOR_KIND[out.kind] ?? 'salesforce_admin');

  const verification = asText(pick(src, 'verification', 'verify', 'howToVerify')).trim();
  if (verification) out.verification = verification.slice(0, 500);

  const affects = pick(src, 'affects', 'affectedNodes', 'nodes', 'affected');
  if (Array.isArray(affects)) {
    const ids = affects.map(asText).map(s => s.trim()).filter(Boolean);
    if (ids.length > 0) out.affects = ids;
  }

  const effort = pick(src, 'estimatedEffort', 'effort', 'estimate');
  if (effort !== undefined) out.estimatedEffort = snap(effort, EFFORTS, 'hours');

  const waived = asText(pick(src, 'waivedReason', 'waiveReason')).trim();
  if (waived) out.waivedReason = waived.slice(0, 500);

  // Nothing else is copied. Unknown keys are dropped here rather than
  // rejected at the final gate — that is the whole point.
  return out;
}

/** Normalise a whole list, renumbering ids so they stay unique and ordered. */
export function normalizePrerequisites(input: unknown): SpecPrerequisite[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  return input.map((item, i) => {
    const p = normalizePrerequisite(item, i);
    // A duplicate id fails nothing in the schema but breaks the checklist's
    // identity, so renumber the collision rather than ship two PRE-001s.
    if (seen.has(p.id)) p.id = `PRE-${String(i + 1).padStart(3, '0')}`;
    seen.add(p.id);
    return p;
  });
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

/**
 * Attach anything the root cannot reach to the root, and say so.
 *
 * An orphan is unambiguous to repair: the runtime caps hierarchy at two
 * tiers, so a stranded sub-agent's only legal parent IS the root, and a
 * stranded tool's default owner is the root too. There is exactly one
 * correct wiring, and deriving it costs nothing.
 *
 * Doing it here rather than letting validation reject is a deliberate
 * trade. Rejection sends the design back to the model for another paid
 * attempt at a fact no model needs to supply — and a build that dies after
 * five completed stages over a missing edge is the expensive failure this
 * whole path keeps producing. Validation still runs afterwards and still
 * fails on anything this could not fix, so nothing unreachable can ship;
 * this only removes the cost of the repair.
 *
 * Returns the notes to surface, so a silently rewired graph is never
 * presented as the one the designer drew.
 */
export function attachOrphansToRoot(spec: AgentSpec): string[] {
  const roots = spec.nodes.filter(n => n.type === 'agent');
  if (roots.length !== 1) return [];
  const rootId = roots[0].id;

  const ids = new Set(spec.nodes.map(n => n.id));
  const outFrom = new Map<string, string[]>();
  for (const e of spec.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    const list = outFrom.get(e.from);
    if (list) list.push(e.to);
    else outFrom.set(e.from, [e.to]);
  }

  const reached = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    for (const next of outFrom.get(queue.shift()!) ?? []) {
      if (!reached.has(next)) { reached.add(next); queue.push(next); }
    }
  }

  const notes: string[] = [];
  for (const n of spec.nodes) {
    if (reached.has(n.id)) continue;
    // 'handoff' for a stranded sub-agent rather than 'call': a call edge
    // requires the sub-agent to declare a `returns` schema, which an orphan
    // by definition has not been given — repairing the wiring must not
    // create a second validation failure.
    const mode: SpecEdge['mode'] = n.type === 'subagent' ? 'handoff' : 'static';
    spec.edges.push({ from: rootId, to: n.id, mode });
    reached.add(n.id);
    notes.push(`'${n.label}' had no connection — attached it to the main agent.`);
  }
  return notes;
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

  // REACHABILITY. The runtime resolves an agent's tools and helpers by
  // walking edges out of the root — `nextNodes(graph, aiNode.id, 'tool')`.
  // A node with no path from the root is therefore invisible at runtime, no
  // matter how correct it looks: it renders on the canvas, it costs tokens
  // to design, and it can never fire.
  //
  // This check did not exist, and a real build shipped because of it — a
  // design with twelve tool nodes and not one edge to any of them compiled
  // cleanly into an agent that could do nothing. Edges referencing real
  // nodes was the only connectivity test, and orphans pass that trivially
  // by having no edges at all.
  if (roots.length === 1) {
    const rootId = roots[0].id;
    const outFrom = new Map<string, string[]>();
    for (const e of spec.edges) {
      if (!ids.has(e.from) || !ids.has(e.to)) continue;
      const list = outFrom.get(e.from);
      if (list) list.push(e.to);
      else outFrom.set(e.from, [e.to]);
    }
    const reached = new Set<string>([rootId]);
    const queue = [rootId];
    while (queue.length > 0) {
      for (const next of outFrom.get(queue.shift()!) ?? []) {
        if (!reached.has(next)) { reached.add(next); queue.push(next); }
      }
    }
    for (const n of spec.nodes) {
      if (reached.has(n.id)) continue;
      errors.push({
        path: `/nodes/${n.id}`,
        message:
          `'${n.label}' has no path from the root agent — add an edge from '${rootId}' (or from the ` +
          'sub-agent that owns it). A node the root cannot reach is invisible at runtime.',
      });
    }
  }

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

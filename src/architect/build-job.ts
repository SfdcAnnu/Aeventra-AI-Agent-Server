/**
 * The Architect build job — the async engine behind "Describe what you
 * need". A full build runs for minutes (far beyond a chat turn's ceiling),
 * so it executes here as a background job the UI polls, exactly as the
 * Building screen assumes.
 *
 * v1 sequence (straight-through; the conversational clarification loop and
 * the test phase arrive next):
 *   understand → survey → match → design (validate + estimate, ≤3 fix
 *   rounds) → prompts → gaps → compile → summary
 *
 * Hard properties:
 *   - budget ceiling per build, checked BEFORE every model call
 *   - the spec validates against schema + logic + the LIVE capability
 *     manifest before anything is written
 *   - the compiler writes Archon records only; blocked designs land as
 *     Draft with prerequisites attached — never Active
 *   - open questions the Analyst could not resolve become recorded
 *     assumptions in the result, never silent guesses
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../logger';
import { getOrgConnection } from '../salesforce/per-org-connection';
import {
  callSpecialist,
  resolveArchitectEngine,
  type ArchitectEngine,
} from './specialists';
import {
  listObjects,
  listInvocables,
  listMcpToolsLive,
  listKnowledgeBases,
  buildCapabilityManifest,
} from './surveyor-tools';
import { validateSpec, type AgentSpec, type SpecPrerequisite, type CapabilityManifest } from './spec';
import { estimateSpec } from './estimate';
import { compileSpec, CompileError } from './compiler';

// ── Job model ────────────────────────────────────────────────────────
export type StepState = 'pending' | 'running' | 'done' | 'warn' | 'failed';

export interface BuildStep {
  key: string;
  label: string;
  state: StepState;
  detail?: string;
}

export interface BuildResult {
  agentId: string;
  apiName: string;
  status: string;
  summarySteps: string[];
  shape: string;
  prerequisites: SpecPrerequisite[];
  estimate: { costPerRunUsd: number; latencySeconds: number };
  assumptions: string[];
  notes: string[];
  confidence: string;
}

export interface BuildJob {
  id: string;
  orgId: string;
  requirement: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  steps: BuildStep[];
  costUsd: number;
  maxCostUsd: number;
  startedAt: number;
  finishedAt?: number;
  result?: BuildResult;
  error?: string;
}

const STEPS: Array<[string, string]> = [
  ['understand', 'Understood what you want'],
  ['survey', 'Looked through your Salesforce org'],
  ['match', 'Matched what you need to what you have'],
  ['design', 'Designed the agent'],
  ['prompts', 'Wrote its instructions'],
  ['gaps', 'Listed the outstanding setup'],
  ['compile', 'Saved the agent'],
];

const jobs = new Map<string, BuildJob>();

export function getBuildJob(id: string): BuildJob | undefined {
  return jobs.get(id);
}

export function createBuildJob(orgId: string, requirement: string, opts?: { attachmentText?: string; maxCostUsd?: number }): BuildJob {
  const job: BuildJob = {
    id: randomUUID(),
    orgId,
    requirement,
    status: 'queued',
    steps: STEPS.map(([key, label]) => ({ key, label, state: 'pending' })),
    costUsd: 0,
    maxCostUsd: opts?.maxCostUsd ?? 2.0,
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  // Opportunistic sweep of finished jobs older than 24h.
  for (const [id, j] of jobs) {
    if (j.finishedAt && Date.now() - j.finishedAt > 24 * 3600_000) jobs.delete(id);
  }
  void runBuild(job, opts?.attachmentText).catch(err => {
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = Date.now();
    logger.error({ jobId: job.id, orgId, err: job.error }, 'architect_build_failed');
  });
  return job;
}

// ── Helpers ──────────────────────────────────────────────────────────
function step(job: BuildJob, key: string): BuildStep {
  return job.steps.find(s => s.key === key)!;
}

function begin(job: BuildJob, key: string): BuildStep {
  const s = step(job, key);
  s.state = 'running';
  return s;
}

function guardBudget(job: BuildJob, about: string): void {
  if (job.costUsd >= job.maxCostUsd) {
    throw new Error(
      `Build budget ceiling reached ($${job.maxCostUsd.toFixed(2)}) before ${about} — ` +
        'nothing else was spent. Raise the ceiling and run again if you want the build finished.',
    );
  }
}

async function specialist<T>(
  job: BuildJob,
  engine: ArchitectEngine,
  id: string,
  input: Record<string, unknown>,
  opts?: { rawJson?: boolean; maxOutputTokens?: number },
): Promise<T> {
  guardBudget(job, `calling the ${id.replace(/_/g, ' ')} specialist`);
  const { result, usage } = await callSpecialist<T>({
    specialistId: id,
    input,
    engine,
    rawJson: opts?.rawJson,
    maxOutputTokens: opts?.maxOutputTokens,
  });
  job.costUsd += usage.costUsd;
  return result;
}

interface Requirement {
  goal: string;
  capabilities: string[];
  trigger?: string;
  successCriteria: string[];
  outOfScope: string[];
  riskLevel: 'low' | 'medium' | 'high';
  openQuestions?: string[];
}

interface MatchResult {
  matched: Array<Record<string, unknown>>;
  partial: Array<Record<string, unknown>>;
  missing: Array<Record<string, unknown>>;
  coverage?: number;
}

// ── The build ────────────────────────────────────────────────────────
async function runBuild(job: BuildJob, attachmentText?: string): Promise<void> {
  job.status = 'running';
  const conn = await getOrgConnection(job.orgId);
  const engine = await resolveArchitectEngine(conn);

  // 1 — understand
  let s = begin(job, 'understand');
  const requirement = await specialist<Requirement>(job, engine, 'analyse_requirement', {
    requirement: job.requirement,
    ...(attachmentText ? { attachedDocument: attachmentText.slice(0, 30_000) } : {}),
    note:
      'This build runs without a back-and-forth: resolve what you can from the text; anything genuinely ' +
      'unresolvable goes in openQuestions as an assumption you made, phrased as the assumption.',
  });
  s.state = 'done';
  s.detail = `${requirement.capabilities.length} capabilities`;

  // 2 — survey (deterministic gather, one compression call)
  s = begin(job, 'survey');
  const [objects, invocables, mcp, kbs, manifestBuilt] = await Promise.all([
    listObjects(job.orgId),
    listInvocables(job.orgId),
    listMcpToolsLive(job.orgId),
    listKnowledgeBases(job.orgId).catch(() => []),
    buildCapabilityManifest(job.orgId),
  ]);
  const manifest: CapabilityManifest = manifestBuilt.manifest;
  const inventoryForModel = {
    requirement,
    objects: objects.slice(0, 250).map(o => ({ n: o.name, l: o.label, c: o.createable, u: o.updateable, q: o.queryable })),
    invocableApex: invocables.filter(i => i.kind === 'apex'),
    flows: invocables.filter(i => i.kind === 'flow'),
    mcpServers: mcp.map(m => ({ provider: m.provider, error: m.error, tools: m.tools })),
    knowledgeBases: kbs,
  };
  const surveyed = await specialist<Record<string, unknown>>(job, engine, 'survey_org', inventoryForModel);
  const found = manifestBuilt.counts.invocables + manifestBuilt.counts.mcpTools + (kbs.length || 0);
  s.state = 'done';
  s.detail = `${found} things found`;

  // 3 — match
  s = begin(job, 'match');
  const match = await specialist<MatchResult>(job, engine, 'match_capabilities', {
    capabilities: requirement.capabilities,
    orgInventory: surveyed,
  });
  const gaps = (match.partial?.length ?? 0) + (match.missing?.length ?? 0);
  s.state = gaps > 0 ? 'warn' : 'done';
  s.detail = gaps > 0 ? `${gaps} gap${gaps === 1 ? '' : 's'}` : 'full coverage';

  // 4 — design, with validation + estimator gates (≤3 rounds)
  s = begin(job, 'design');
  const customer = /whatsapp|sms|customer|web chat/i.test(job.requirement + (requirement.trigger ?? ''));
  const targets = customer ? { costUsd: 0.06, latencySeconds: 4 } : { costUsd: 0.15, latencySeconds: 8 };
  let spec: AgentSpec | null = null;
  let feedback = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const draft = await specialist<AgentSpec>(job, engine, 'design_flow', {
      requirement,
      matched: match.matched,
      partial: match.partial,
      missing: match.missing,
      instruction:
        'Emit ONE complete AgentSpec JSON object (specVersion 1.0) and nothing else. Sub-agents need a ' +
        'description (when to use them). Only v1-compilable elements: trigger inbound_message/manual/webhook; ' +
        'node types agent/subagent/tool/tool_catalog; crud create/update/query. Leave instructions minimal — ' +
        'the Prompt Engineer fills them in.',
      ...(feedback ? { previousAttemptErrors: feedback } : {}),
    }, { rawJson: true, maxOutputTokens: 8000 });
    const errors = validateSpec(draft, manifest);
    if (errors.length > 0) {
      feedback = errors.map(e => `${e.path}: ${e.message}`).join('\n');
      if (attempt === 3) throw new Error('The design would not validate after 3 attempts:\n' + feedback);
      continue;
    }
    const est = estimateSpec(draft, targets);
    if (!est.withinBudget && attempt < 3) {
      feedback =
        `The design is over budget (warm $${est.warmUsd.toFixed(3)} vs $${targets.costUsd}, ` +
        `${est.latencySeconds}s vs ${targets.latencySeconds}s). Apply these levers and re-emit:\n- ` +
        est.levers.join('\n- ');
      continue;
    }
    spec = draft;
    if (!est.withinBudget) {
      step(job, 'design').detail = `over target: $${est.warmUsd.toFixed(3)}/run`;
    }
    break;
  }
  if (!spec) throw new Error('No valid design produced.');
  s.state = 'done';
  s.detail = s.detail ?? `${spec.nodes.filter(n => n.type === 'subagent').length} helper(s), ${spec.nodes.filter(n => n.type === 'tool').length} tool(s)`;

  // 5 — prompts
  s = begin(job, 'prompts');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const withPrompts = await specialist<AgentSpec>(job, engine, 'write_prompts', {
      draftSpec: spec,
      requirement,
      instruction: 'Return the SAME AgentSpec JSON with instructions and descriptions filled in — change nothing else.',
      ...(feedback && attempt > 1 ? { previousAttemptErrors: feedback } : {}),
    }, { rawJson: true, maxOutputTokens: 12_000 });
    const errors = validateSpec(withPrompts, manifest);
    if (errors.length === 0) {
      spec = withPrompts;
      break;
    }
    feedback = errors.map(e => `${e.path}: ${e.message}`).join('\n');
    if (attempt === 3) throw new Error('The prompted spec would not validate after 3 attempts:\n' + feedback);
  }
  s.state = 'done';

  // 6 — gaps
  s = begin(job, 'gaps');
  let prerequisites: SpecPrerequisite[] = [];
  if (gaps > 0) {
    const gapOut = await specialist<{ prerequisites: SpecPrerequisite[]; blockingCount?: number }>(
      job, engine, 'report_gaps',
      { partial: match.partial, missing: match.missing, orgInventory: surveyed, specNodes: spec.nodes.map(n => n.id) },
    );
    prerequisites = gapOut.prerequisites ?? [];
  }
  const blockingCount = prerequisites.filter(p => p.blocking && p.status !== 'done' && p.status !== 'waived').length;
  spec.prerequisites = prerequisites;
  spec.lifecycle = { state: blockingCount > 0 ? 'blocked' : 'draft', version: 1 };
  s.state = 'done';
  s.detail = blockingCount > 0 ? `${blockingCount} blocking` : prerequisites.length > 0 ? `${prerequisites.length} optional` : 'nothing missing';

  // 7 — compile (deterministic; writes Archon records only)
  s = begin(job, 'compile');
  const finalErrors = validateSpec(spec, manifest);
  if (finalErrors.length > 0) {
    throw new Error('Final spec failed validation:\n' + finalErrors.map(e => `${e.path}: ${e.message}`).join('\n'));
  }
  let compiled;
  try {
    compiled = await compileSpec(spec, { conn, orgId: job.orgId, manifest });
  } catch (e) {
    throw e instanceof CompileError ? new Error('Compile refused: ' + e.message) : e;
  }
  s.state = 'done';
  s.detail = compiled.apiName;

  // 8 — result (deterministic summary; no model call)
  const est = estimateSpec(spec);
  const subCount = spec.nodes.filter(n => n.type === 'subagent').length;
  job.result = {
    agentId: compiled.agentId,
    apiName: compiled.apiName,
    status: compiled.status,
    summarySteps: buildSummarySentences(spec),
    shape: subCount === 0 ? '1 agent' : `1 agent + ${subCount} helper${subCount === 1 ? '' : 's'}`,
    prerequisites,
    estimate: { costPerRunUsd: Number(est.warmUsd.toFixed(3)), latencySeconds: est.latencySeconds },
    assumptions: requirement.openQuestions ?? [],
    notes: compiled.notes,
    confidence: buildConfidence(requirement, match, prerequisites),
  };
  job.status = 'done';
  job.finishedAt = Date.now();
  logger.info(
    { jobId: job.id, orgId: job.orgId, agentId: compiled.agentId, costUsd: Number(job.costUsd.toFixed(4)), ms: Date.now() - job.startedAt },
    'architect_build_done',
  );
}

/** The Review screen's numbered sentences — from the spec, deterministically. */
function buildSummarySentences(spec: AgentSpec): string[] {
  const out: string[] = [];
  if (spec.trigger.type === 'inbound_message') {
    out.push(`Answers when a message arrives${spec.trigger.channel ? ` on ${spec.trigger.channel}` : ''}`);
  }
  for (const n of spec.nodes) {
    if (n.type === 'subagent') out.push(`${n.description ?? n.label} — a helper handles this`);
    if (n.type === 'tool') out.push(n.description ?? n.label);
  }
  return out.slice(0, 8);
}

function buildConfidence(req: Requirement, match: MatchResult, prereqs: SpecPrerequisite[]): string {
  const parts: string[] = [];
  if (req.openQuestions?.length) parts.push(`I assumed: ${req.openQuestions[0]}`);
  if ((match.partial?.length ?? 0) > 0) {
    parts.push('the partial capability matches are where I am least sure — read the named matches before going live');
  }
  if (prereqs.some(p => p.blocking)) parts.push('nothing runs until the blocking setup items are done');
  if (parts.length === 0) parts.push('the requirement was specific and everything matched — the main risk is untested edge cases until the test phase runs');
  return parts.join('; ') + '.';
}

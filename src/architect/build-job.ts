/**
 * The Architect build job — the async engine behind "Describe what you
 * need". A full build runs for minutes (far beyond a chat turn's ceiling),
 * so it executes here as a background job the UI polls, exactly as the
 * Building screen assumes.
 *
 * v1 sequence (straight-through; the conversational clarification loop and
 * the test phase arrive next):
 *   understand → survey → match → design (validate + estimate, ≤3 fix
 *   rounds) → prompts → review → gaps → compile → summary
 *
 * Hard properties:
 *   - budget ceiling per build, checked BEFORE every model call
 *   - EVERY STAGE IS CHECKPOINTED the moment it succeeds, and the ceiling
 *     PAUSES the build rather than failing it. These two go together: the
 *     guard has always refused to overspend, but it used to throw away the
 *     stages already paid for along with it, so the customer re-ran from
 *     zero and bought the same survey and the same design a second time.
 *     A resumed build re-runs only what never finished.
 *   - the spec validates against schema + logic + the LIVE capability
 *     manifest before anything is written
 *   - the compiler writes Archon records only; blocked designs land as
 *     Draft with prerequisites attached — never Active
 *   - open questions the Analyst could not resolve become recorded
 *     assumptions in the result, never silent guesses
 *   - the finished design is JUDGED AGAINST THE REQUIREMENT before it is
 *     saved. Every other gate asks whether the spec is valid, which an
 *     agent that quietly does less than was asked for passes easily. The
 *     review is the only one that asks whether it does what the client
 *     said — and anything it finds missing leads the result's notes.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../db/client';
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
import { validateSpec, normalizePrerequisites, attachOrphansToRoot, type AgentSpec, type SpecNode, type SpecError, type SpecPrerequisite, type CapabilityManifest } from './spec';
import { estimateSpec } from './estimate';
import { SpecialistError, type SpecialistUsage } from './specialists';
import { repairNames, type AvailableNames } from './name-repair';
import { applyPromptMap, applySpecPatch, isSpecPatch } from './spec-merge';
import { inventoryFromGather } from './survey-inventory';
import { compileSpec, CompileError } from './compiler';

// ── Job model ────────────────────────────────────────────────────────
export type StepState = 'pending' | 'running' | 'done' | 'warn' | 'failed';

export interface BuildStep {
  key: string;
  label: string;
  state: StepState;
  detail?: string;
  /** What THIS stage cost and took. Shown per row so the expensive stage is
   *  visible rather than inferred from one total. */
  costUsd?: number;
  ms?: number;
  /** Restored from an earlier run's checkpoint — done, and free. */
  reused?: boolean;
  /** Every model call this stage made, in order — the empty ones too.
   *  A stage that showed one cost figure hid that it had paid for two
   *  calls; this is what says where a build's money and minutes went. */
  calls?: BuildCall[];
  tokensIn?: number;
  tokensOut?: number;
}

export interface BuildCall {
  specialist: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  ms: number;
  /** Set when the call produced nothing usable: what it said. */
  failed?: string;
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
  /** How the finished design measured against the requirement. */
  review?: ReviewResult;
  confidence: string;
}

/**
 * Everything a build has produced so far, keyed by the stage that produced
 * it. Written the instant a stage succeeds; read on resume INSTEAD of
 * re-running that stage — re-deriving is the precise cost this exists to
 * avoid.
 *
 * The capability manifest is deliberately NOT here. It is a free,
 * deterministic gather rather than a model call, and the org may have
 * changed between runs — validating a resumed design against a stale
 * manifest would approve a spec the org can no longer support.
 */
export interface BuildCheckpoint {
  requirement?: Requirement;
  surveyed?: Record<string, unknown>;
  match?: MatchResult;
  spec?: AgentSpec;
  review?: ReviewResult;
  prerequisites?: SpecPrerequisite[];
}

/** The Evaluator's verdict on the finished design, judged against the
 *  REQUIREMENT rather than against the design's own reasoning. */
export interface ReviewResult {
  verdict: 'pass' | 'pass_with_risk' | 'blocked' | 'fail';
  /** Requirement items nothing in the graph covers. The omission this
   *  whole stage exists to catch. */
  uncovered?: string[];
  failures?: Array<Record<string, unknown>>;
  fixes?: Array<Record<string, unknown>>;
  /** True when a repair round ran and the verdict below is the re-check. */
  repaired?: boolean;
}

export interface BuildJob {
  id: string;
  orgId: string;
  requirement: string;
  attachmentText?: string;
  /** `paused` is a budget stop with its work intact — resumable, not failed. */
  status: 'queued' | 'running' | 'paused' | 'done' | 'failed';
  steps: BuildStep[];
  checkpoint: BuildCheckpoint;
  costUsd: number;
  /** Spent by earlier runs in this resume chain. The ceiling applies to the
   *  SUM, so resuming cannot walk past the limit one run at a time. */
  priorCostUsd: number;
  maxCostUsd: number;
  resumedFrom?: string;
  /** Pause after this stage with the work saved — a stage tool running the
   *  build one stage at a time. In memory only; each run names its own. */
  stopAfter?: string;
  /** The stage whose model calls are being made. In memory only. */
  currentStep?: string;
  startedAt: number;
  finishedAt?: number;
  result?: BuildResult;
  error?: string;
  /** Set only on listings: checkpointed by an older pipeline. */
  stale?: boolean;
}

const STEPS: Array<[string, string]> = [
  ['understand', 'Understood what you want'],
  ['survey', 'Looked through your Salesforce org'],
  ['match', 'Matched what you need to what you have'],
  ['design', 'Designed the agent'],
  ['prompts', 'Wrote its instructions'],
  ['review', 'Checked it against what you asked for'],
  ['gaps', 'Listed the outstanding setup'],
  ['compile', 'Saved the agent'],
];

/** The objects nearly every requirement actually touches. Custom objects
 *  are always included on top of these. */
/** How many times a tool server that did not answer is re-read before the
 *  build gives up, and how long to wait between tries. Sized for a cold
 *  start of about thirty seconds, not for an outage. */
const MCP_WAKE_ATTEMPTS = Number(process.env.ARCHITECT_MCP_WAKE_ATTEMPTS) || 3;
const MCP_WAKE_WAIT_MS = Number(process.env.ARCHITECT_MCP_WAKE_WAIT_MS) || 15_000;

const CORE_OBJECTS = new Set([
  'Account', 'Contact', 'Lead', 'Opportunity', 'OpportunityLineItem', 'Case', 'Task', 'Event',
  'Product2', 'Pricebook2', 'PricebookEntry', 'Quote', 'QuoteLineItem', 'Contract', 'Order',
  'Campaign', 'CampaignMember', 'User', 'Knowledge__kav', 'ContentDocument', 'EmailMessage',
]);

const jobs = new Map<string, BuildJob>();

/**
 * The budget ceiling, reached. Not a failure: everything already paid for
 * is in the checkpoint, and the build resumes from exactly here.
 */
/** Thrown when a run reaches the stage it was asked to stop after. */
class StagePause extends Error {
  constructor(public readonly key: string, public readonly label: string) {
    super(`stopped after ${key}`);
  }
}

class BudgetPause extends Error {
  constructor(readonly about: string) {
    super(`Paused before ${about} — the budget ceiling was reached.`);
    this.name = 'BudgetPause';
  }
}

// ── Persistence ──────────────────────────────────────────────────────
// The in-memory Map is the fast path for polling; the table is what lets a
// build survive the host restarting, which on a spin-down host is a routine
// event rather than an incident.

/** Never let a persistence failure end a build that is otherwise fine. */
async function saveJob(job: BuildJob): Promise<void> {
  try {
    const data = {
      orgId: job.orgId,
      requirement: job.requirement,
      attachmentText: job.attachmentText ?? null,
      status: job.status,
      steps: job.steps as never,
      checkpoint: job.checkpoint as never,
      costUsd: job.costUsd,
      priorCostUsd: job.priorCostUsd,
      maxCostUsd: job.maxCostUsd,
      resumedFrom: job.resumedFrom ?? null,
      result: (job.result ?? undefined) as never,
      error: job.error ?? null,
      startedAt: new Date(job.startedAt),
      finishedAt: job.finishedAt ? new Date(job.finishedAt) : null,
    };
    await prisma.architectBuild.upsert({
      where: { id: job.id },
      create: { id: job.id, ...data },
      update: data,
    });
  } catch (err) {
    logger.warn({ jobId: job.id, err: err instanceof Error ? err.message : err }, 'architect_build_persist_failed');
  }
}

function fromRow(row: {
  id: string; orgId: string; requirement: string; attachmentText: string | null;
  status: string; steps: unknown; checkpoint: unknown; costUsd: number;
  priorCostUsd: number; maxCostUsd: number; resumedFrom: string | null;
  result: unknown; error: string | null; startedAt: Date; finishedAt: Date | null;
}): BuildJob {
  return {
    id: row.id,
    orgId: row.orgId,
    requirement: row.requirement,
    attachmentText: row.attachmentText ?? undefined,
    status: row.status as BuildJob['status'],
    steps: (row.steps ?? []) as BuildStep[],
    checkpoint: (row.checkpoint ?? {}) as BuildCheckpoint,
    costUsd: row.costUsd,
    priorCostUsd: row.priorCostUsd,
    maxCostUsd: row.maxCostUsd,
    resumedFrom: row.resumedFrom ?? undefined,
    result: (row.result ?? undefined) as BuildResult | undefined,
    error: row.error ?? undefined,
    startedAt: row.startedAt.getTime(),
    finishedAt: row.finishedAt?.getTime(),
  };
}

/** In-memory first (a running build's live state), then the table. */
export async function getBuildJob(id: string, orgId: string): Promise<BuildJob | undefined> {
  const live = jobs.get(id);
  if (live) return live.orgId === orgId ? live : undefined;
  try {
    const row = await prisma.architectBuild.findFirst({ where: { id, orgId } });
    return row ? fromRow(row) : undefined;
  } catch (err) {
    logger.warn({ jobId: id, err: err instanceof Error ? err.message : err }, 'architect_build_load_failed');
    return undefined;
  }
}

/**
 * Forget a build and everything it checkpointed.
 *
 * Needed because a checkpoint outlives the agent it was going to create:
 * the build lives in Postgres, the agent in Salesforce, and deleting the
 * agent deliberately does not touch the build — that separation is what
 * makes a failed build resumable at all. Without this, a checkpoint the
 * client has finished with sits in their "you can finish these" list
 * forever, offering to rebuild something they deleted on purpose.
 */
export async function deleteBuild(orgId: string, jobId: string): Promise<boolean> {
  jobs.delete(jobId);
  try {
    const { count } = await prisma.architectBuild.deleteMany({ where: { id: jobId, orgId } });
    return count > 0;
  } catch (err) {
    logger.warn({ jobId, err: err instanceof Error ? err.message : err }, 'architect_build_delete_failed');
    return false;
  }
}

/**
 * Was this build checkpointed by an older pipeline?
 *
 * Its saved stage list is the evidence: a build that ran when there were
 * seven stages cannot have been through a review that did not exist yet.
 * Resuming one replays a design made under rules that have since changed,
 * which reproduces the very agent the fixes were written to prevent — so
 * it is offered with a warning rather than silently or not at all.
 */
function isStale(job: BuildJob): boolean {
  return job.steps.length !== STEPS.length;
}

/** Paused builds an org could resume, newest first. */
export async function listResumableBuilds(orgId: string, limit = 10): Promise<BuildJob[]> {
  try {
    const rows = await prisma.architectBuild.findMany({
      // Failed builds are candidates too — the ones with any completed
      // stage saved, which is what `resumeBuildJob` will actually accept.
      where: { orgId, status: { in: ['paused', 'failed'] } },
      orderBy: { startedAt: 'desc' },
      take: limit * 2,
    });
    return rows
      .map(fromRow)
      .filter(b => b.status === 'paused' || Object.keys(b.checkpoint ?? {}).length > 0)
      .map(b => ({ ...b, stale: isStale(b) }))
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** A thrown reason as one readable row on the build card. The design
  * stage's reason is several lines — the headline and then each thing
  * that was wrong — and the headline alone ("would not validate after 3
  * attempts:") says nothing the client can act on. */
function clipLine(message: string, max = 180): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function launch(job: BuildJob): BuildJob {
  jobs.set(job.id, job);
  // Opportunistic sweep of finished jobs older than 24h — the table keeps
  // them, this Map only needs the ones still being polled.
  for (const [id, j] of jobs) {
    if (j.finishedAt && Date.now() - j.finishedAt > 24 * 3600_000) jobs.delete(id);
  }
  void saveJob(job);
  void runBuild(job).catch(err => {
    // A step showing `running` when a build PAUSES never actually ran —
    // the guard fires before the call it was going to pay for — so it goes
    // back to pending and the resume starts in the right place.
    //
    // A FAILURE IS THE OPPOSITE, AND USED TO BE TOLD THE SAME WAY. The
    // design stage that burnt three attempts and threw was reset to
    // pending too, so the card showed seven stages waiting and nothing
    // wrong. The client pressed Continue, got "cannot be resumed", and
    // had no way to learn that the stage had already run and failed. The
    // stage that threw keeps its failure, and the reason with it.
    const failing = !(err instanceof StagePause) && !(err instanceof BudgetPause);
    for (const s of job.steps) {
      if (s.state !== 'running') continue;
      if (failing) {
        s.state = 'failed';
        s.detail = clipLine(err instanceof Error ? err.message : String(err));
      } else {
        s.state = 'pending';
      }
    }
    job.finishedAt = Date.now();
    if (err instanceof StagePause) {
      job.status = 'paused';
      job.error = `Stopped after "${err.label}" as asked — everything so far is saved; the next stage resumes from here.`;
      logger.info({ jobId: job.id, orgId: job.orgId, after: err.key }, 'architect_build_stopped_after_stage');
    } else if (err instanceof BudgetPause) {
      job.status = 'paused';
      job.error =
        `Stopped at the $${job.maxCostUsd.toFixed(2)} ceiling, before ${err.about}. ` +
        'Everything finished so far has been saved — resume to continue from here, ' +
        'and you will not be charged again for the stages already done.';
      logger.info(
        { jobId: job.id, orgId: job.orgId, costUsd: Number((job.priorCostUsd + job.costUsd).toFixed(4)), at: err.about },
        'architect_build_paused',
      );
    } else {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      logger.error({ jobId: job.id, orgId: job.orgId, err: job.error }, 'architect_build_failed');
    }
    void saveJob(job);
  });
  return job;
}

export function createBuildJob(orgId: string, requirement: string, opts?: { attachmentText?: string; maxCostUsd?: number; stopAfter?: string }): BuildJob {
  return launch({
    id: randomUUID(),
    orgId,
    requirement,
    attachmentText: opts?.attachmentText,
    status: 'queued',
    steps: STEPS.map(([key, label]) => ({ key, label, state: 'pending' })),
    checkpoint: {},
    costUsd: 0,
    priorCostUsd: 0,
    // Eight stages now, one of them a review that exists to stop a wrong
    // agent reaching a customer. $2 was set when there were seven and no
    // review, and a single failed design stage can spend half of it.
    maxCostUsd: opts?.maxCostUsd ?? 4.0,
    stopAfter: opts?.stopAfter,
    startedAt: Date.now(),
  });
}

/**
 * Continue a paused build. The new run inherits the checkpoint, so every
 * stage already paid for is restored rather than re-run, and inherits the
 * spend so the ceiling still governs the whole chain.
 *
 * A FAILED build is resumable too, as long as its checkpoint holds
 * ANYTHING. Failures here are overwhelmingly a late gate rejecting a
 * shape an earlier stage produced — and the repair for that ships in this
 * code, not in the model's next attempt. Making the customer re-buy the
 * survey to pick up a fix they already paid to discover is the same
 * waste the checkpoint exists to end.
 *
 * THIS USED TO REQUIRE A SAVED DESIGN, which is the one thing a failed
 * design stage does not have. A build spent $1.96 reaching the designer,
 * failed there, and became unresumable — so the understanding, the survey
 * and the match, all finished and all paid for, were thrown away to
 * re-run a stage whose fix had already shipped. The design is not the
 * only artefact worth keeping; every completed stage is.
 *
 * Returns null when there is nothing resumable under that id.
 */
export async function resumeBuildJob(
  orgId: string,
  jobId: string,
  maxCostUsd?: number,
  stopAfter?: string,
): Promise<BuildJob | null> {
  const prior = await getBuildJob(jobId, orgId);
  if (!prior) return null;
  const resumable =
    prior.status === 'paused' ||
    (prior.status === 'failed' && Object.keys(prior.checkpoint ?? {}).length > 0);
  if (!resumable) return null;

  const spent = prior.priorCostUsd + prior.costUsd;
  return launch({
    id: randomUUID(),
    orgId,
    requirement: prior.requirement,
    attachmentText: prior.attachmentText,
    status: 'queued',
    // Reused stages are re-marked as the run restores them; anything not in
    // the checkpoint starts pending again.
    steps: STEPS.map(([key, label]) => ({ key, label, state: 'pending' })),
    checkpoint: prior.checkpoint,
    costUsd: 0,
    priorCostUsd: spent,
    // Default headroom rather than a hard requirement to name a number —
    // but it is headroom ON TOP of what is already spent, so the chain
    // total is always what the ceiling means.
    maxCostUsd: maxCostUsd ?? Number((spent + 2).toFixed(2)),
    resumedFrom: prior.id,
    stopAfter,
    startedAt: Date.now(),
  });
}

// ── Helpers ──────────────────────────────────────────────────────────
function step(job: BuildJob, key: string): BuildStep {
  job.currentStep = key;
  return job.steps.find(s => s.key === key)!;
}

function recordCall(job: BuildJob, specialist: string, model: string, usage: SpecialistUsage, failed?: string): void {
  const s = job.currentStep ? job.steps.find(x => x.key === job.currentStep) : undefined;
  if (!s) return;
  (s.calls ??= []).push({
    specialist, model, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut,
    costUsd: Number(usage.costUsd.toFixed(4)), ms: usage.ms, ...(failed ? { failed } : {}),
  });
  s.tokensIn = (s.tokensIn ?? 0) + usage.tokensIn;
  s.tokensOut = (s.tokensOut ?? 0) + usage.tokensOut;
}

/** Entering `key`: if the run was asked to stop after the stage before it,
 *  stop now — the previous stage's work is in the checkpoint. */
function guardStop(job: BuildJob, key: string): void {
  if (!job.stopAfter) return;
  const i = STEPS.findIndex(([k]) => k === key);
  if (i > 0 && STEPS[i - 1][0] === job.stopAfter) throw new StagePause(job.stopAfter, STEPS[i - 1][1]);
}

function guardBudget(job: BuildJob, about: string): void {
  if (job.priorCostUsd + job.costUsd >= job.maxCostUsd) throw new BudgetPause(about);
}

/**
 * Run one stage, or restore it from an earlier run.
 *
 * This is where resumability actually lives: a stage whose output is
 * already in the checkpoint is marked done and costs nothing, and a stage
 * that does run writes its output to the checkpoint — and to the table —
 * BEFORE the next one can hit the ceiling. Nothing paid for is ever held
 * only in a local variable again.
 */
async function stage<T>(
  job: BuildJob,
  key: string,
  cached: T | undefined,
  produce: () => Promise<T>,
  describe: (value: T) => { detail: string; state?: StepState },
  keep?: (value: T) => void,
): Promise<T> {
  guardStop(job, key);
  const s = step(job, key);

  // A SUMMARY LINE MUST NEVER FAIL A BUILD.
  //
  // `describe` exists to write one sentence under a stage on the screen.
  // It reads fields off a model's answer, so it can meet an absent one,
  // and three separate builds died in it — .filter on missing nodes,
  // .replace on a missing verdict — after the stage itself had succeeded
  // and been paid for. The work is done by the time this runs; losing the
  // caption is not a reason to lose the work.
  const safely = (value: T): { detail: string; state?: StepState } => {
    try {
      return describe(value);
    } catch (err) {
      logger.warn(
        { jobId: job.id, orgId: job.orgId, stage: key, err: err instanceof Error ? err.message : String(err) },
        'architect_stage_summary_failed',
      );
      return { detail: '' };
    }
  };

  if (cached !== undefined) {
    const d = safely(cached);
    s.state = d.state ?? 'done';
    s.detail = d.detail;
    s.reused = true;
    s.costUsd = 0;
    return cached;
  }

  s.state = 'running';
  const startedAt = Date.now();
  const spentBefore = job.costUsd;
  const value = await produce();
  s.ms = Date.now() - startedAt;
  s.costUsd = Number((job.costUsd - spentBefore).toFixed(4));
  const d = safely(value);
  s.state = d.state ?? 'done';
  s.detail = d.detail;
  keep?.(value);
  await saveJob(job);
  return value;
}

/** A reasoning model that spent its whole allowance thinking and answered
 *  with nothing. Distinct from a model that answered badly. */
const RETURNED_NOTHING = /did not return a JSON object — it returned \(nothing at all\)/;

async function specialist<T>(
  job: BuildJob,
  engine: ArchitectEngine,
  id: string,
  input: Record<string, unknown>,
  opts?: { rawJson?: boolean; maxOutputTokens?: number; effort?: 'minimal' | 'low' | 'medium' | 'high' },
): Promise<T> {
  guardBudget(job, `calling the ${id.replace(/_/g, ' ')} specialist`);
  const call = async (maxOutputTokens?: number): Promise<T> => {
    try {
      const { result, usage, model } = await callSpecialist<T>({
        specialistId: id,
        input,
        engine,
        rawJson: opts?.rawJson,
        maxOutputTokens,
        effortOverride: opts?.effort,
      });
      job.costUsd += usage.costUsd;
      recordCall(job, id, model, usage);
      return result;
    } catch (err) {
      // A call that produced nothing still ran and was still billed. It
      // used to vanish from the books — the stage showed one call where
      // two had been paid for, and the ceiling never saw the first.
      if (err instanceof SpecialistError && err.usage) {
        job.costUsd += err.usage.costUsd;
        recordCall(job, id, err.model ?? modelForTierName(engine), err.usage, err.message.slice(0, 160));
      }
      throw err;
    }
  };

  try {
    return await call(opts?.maxOutputTokens);
  } catch (err) {
    // An empty answer means the budget ran out mid-thought, not that the
    // task was impossible — so retrying it unchanged just buys the same
    // silence twice. Retry ONCE with real room. The cost of one wider call
    // is far below the cost of discarding a build that has already paid for
    // five stages, which is exactly what used to happen here.
    const message = err instanceof Error ? err.message : String(err);
    if (!RETURNED_NOTHING.test(message)) throw err;

    const wider = Math.min((opts?.maxOutputTokens ?? 8_000) * 2, 32_000);
    logger.warn(
      { jobId: job.id, specialist: id, from: opts?.maxOutputTokens ?? null, to: wider },
      'architect_specialist_empty_retrying_wider',
    );
    guardBudget(job, `retrying the ${id.replace(/_/g, ' ')} specialist with more room`);
    return await call(wider);
  }
}

/** For a failed call whose model was not reported. */
function modelForTierName(engine: ArchitectEngine): string {
  return engine.models[0] ?? '?';
}

/** An agent or sub-agent without instructions, or a tool without a
 *  description: what the Prompt Engineer still has to write. */
function needsText(n: SpecNode): boolean {
  if (n.type === 'agent' || n.type === 'subagent') return (n.instructions ?? '').trim().length === 0;
  if (n.type === 'tool') return (n.description ?? '').trim().length === 0;
  return false;
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

/** What the Flow Designer is told on a full emit. */
const DESIGN_INSTRUCTION =
            'Emit ONE complete AgentSpec JSON object (specVersion 1.0) and nothing else. Sub-agents need a ' +
            'description (when to use them). Only v1-compilable elements: trigger inbound_message/manual/webhook; ' +
            'node types agent/subagent/tool/tool_catalog; crud create/update/query. Leave instructions minimal — ' +
            'the Prompt Engineer fills them in.\n\n' +
            'EVERY node must be connected: emit an edge from the root to each sub-agent, and from its owner to ' +
            'each tool. A node with no edge is invisible at runtime.\n\n' +
            'EVERY tool node names the server that publishes it in `action.connector`, using the provider key the Surveyor reported (salesforce_mcp for the standard create/update/query and schema tools, the connector\'s own key for anything else). Leave it blank and the tool is looked for on the wrong server and shows as unconfigured to the client.\n\n' +
            'One tool node per TOOL, not one per record type — every node is re-sent to the model on every ' +
            'turn, so near-duplicates cost the client on every conversation. BUT THE TWO KINDS SAY THIS ' +
            'DIFFERENTLY, and picking the wrong one produces a design that cannot validate. A tool that ' +
            'takes the record type as an ARGUMENT is one node and is an `mcp` action carrying that ' +
            'tool\'s exact name. A `crud` action is the other thing entirely: a permission granted on ' +
            'ONE object, so it always carries action.sobject AND action.operation. There is no crud ' +
            'action without an object — if you find yourself writing a general \"create a record\" node, ' +
            'you wanted the mcp tool.\n\n' +
            'EVERY name you write must be COPIED from `available`, character for character. `available.mcp` ' +
            'lists each connector with the tools it publishes; `available.crud` lists each object with the ' +
            'operations permitted on it. A name that is not in there was not found, and a tool that was ' +
            'not found cannot be used — so do not reshape a name into the casing or the underscores you ' +
            'would expect it to have.\n\n' +
            'When the requirement says an action needs human approval, set approval.required on THAT tool node.\n\n' +
            'Set `audience`: "customer" if the replies are read by someone outside the business, "internal" if ' +
            'they are read by an employee. Decide it from the requirement, never from the channel — a web chat ' +
            'can be a public widget or a staff tool, and the two need opposite handling.';

/** What it is told when patching a design that already exists. */
const DESIGN_PATCH_INSTRUCTION =
  'The design in currentDesign failed for exactly the reasons listed. Return ONE JSON object with ONLY what changes: ' +
  '{"nodes": [full node objects to add, or to replace the node with the same id], "removeNodeIds": [ids to drop], ' +
  '"edges": [the complete edge list, only if an edge changes]}. Do not return unchanged nodes, do not return prose, ' +
  'and copy every tool and object name character for character from `available`.';

// ── The build ────────────────────────────────────────────────────────
/**
 * Take ownership of this build in Postgres before spending anything on it.
 *
 * `jobs` is an in-memory Map and saveJob swallows its own failures, so the
 * running build lives in a process and the table is a best-effort copy.
 * On one instance that costs a build on restart. On two it costs money:
 * both can resume the same chain and buy the same survey twice, and a
 * status poll landing on the other instance reads a stale row.
 *
 * A conditional UPDATE is the whole fix. Exactly one caller can move a row
 * out of queued/paused/failed, and whoever loses stops before the first
 * model call rather than racing.
 */
async function claimBuild(job: BuildJob): Promise<boolean> {
  try {
    const { count } = await prisma.architectBuild.updateMany({
      where: { id: job.id, orgId: job.orgId, status: { in: ['queued', 'paused', 'failed'] } },
      data: { status: 'running' },
    });
    return count === 1;
  } catch (err) {
    // The row may not exist yet: launch() persists in the background, and
    // a brand-new build is queued in memory before its first write lands.
    // Refusing here would fail every build whose insert is a millisecond
    // behind, so an unreadable table is not treated as someone else's
    // claim.
    logger.warn({ jobId: job.id, err: err instanceof Error ? err.message : err }, 'architect_build_claim_failed');
    return true;
  }
}

async function runBuild(job: BuildJob): Promise<void> {
  if (!(await claimBuild(job))) {
    logger.info({ jobId: job.id, orgId: job.orgId }, 'architect_build_already_claimed');
    throw new Error(
      'This build is already running somewhere else. Watch that one rather than starting it again — ' +
      'nothing has been charged twice.',
    );
  }
  job.status = 'running';
  const attachmentText = job.attachmentText;
  const conn = await getOrgConnection(job.orgId);
  const engine = await resolveArchitectEngine(conn);
  const cp = job.checkpoint;

  // The org gathering needs nothing from the Analyst, so it runs WHILE the
  // requirement is being understood instead of after it — on a cold MCP
  // host that listing alone is tens of seconds. It is also re-run on every
  // resume rather than checkpointed: it costs nothing, and the capability
  // manifest MUST reflect the org as it is now, not as it was when the
  // paused run read it.
  const orgGather = Promise.all([
    listObjects(job.orgId),
    listInvocables(job.orgId),
    listMcpToolsLive(job.orgId),
    listKnowledgeBases(job.orgId).catch(() => []),
    buildCapabilityManifest(job.orgId),
  ]);
  orgGather.catch(() => { /* surfaced when awaited below */ });

  // 1 — understand
  const requirement = await stage<Requirement>(
    job, 'understand', cp.requirement,
    () => specialist<Requirement>(job, engine, 'analyse_requirement', {
      requirement: job.requirement,
      ...(attachmentText ? { attachedDocument: attachmentText.slice(0, 30_000) } : {}),
      note:
        'This build runs without a back-and-forth: resolve what you can from the text; anything genuinely ' +
        'unresolvable goes in openQuestions as an assumption you made, phrased as the assumption.',
    }),
    r => ({ detail: `${r.capabilities.length} capabilities` }),
    r => { cp.requirement = r; },
  );

  const [objects, invocables, mcpFirstRead, kbs, manifestBuilt] = await orgGather;
  const manifest: CapabilityManifest = manifestBuilt.manifest;
  const found = manifestBuilt.counts.invocables + manifestBuilt.counts.mcpTools + (kbs.length || 0);

  // A SURVEY THAT PARTLY FAILED CANNOT BE DESIGNED AGAINST.
  //
  // Everything downstream treats this inventory as the truth about the org.
  // When a connected MCP server is unreachable its tools come back empty,
  // and the build carries on cheerfully: it designs around capabilities the
  // org actually has, and the Gap Reporter tells the client to go and build
  // them. That is the worst output this system can produce — confidently
  // wrong, expensive, and aimed at an admin who will do the work.
  //
  // 'not connected' is excluded because it is a real answer: the org has
  // genuinely not connected that provider, and a gap is the correct result.
  // What stops the build is a server that should have answered and did not.
  // Every tool the org can actually call. The reviewer needs this to tell a
  // real omission from a capability that is already within reach.
  // A SLEEPING TOOL SERVER IS NOT A MISSING CAPABILITY.
  //
  // These servers idle out and take about half a minute to answer their
  // first request, and the error they return says so itself: "should
  // answer again in under a minute". Throwing on the first read turned a
  // predictable half-minute wait into a dead build that had already been
  // paid for up to this point.
  //
  // So providers that did not answer are re-read a few times before giving
  // up. Bounded deliberately: this waits out a cold start, it does not
  // paper over a server that is genuinely down. A server still silent
  // afterwards stops the build with the same message, because designing
  // around tools we cannot see is worse than stopping.
  let mcp = mcpFirstRead;
  for (let attempt = 1; attempt <= MCP_WAKE_ATTEMPTS; attempt++) {
    const asleep = mcp.filter(m => m.error && m.error !== 'not connected');
    if (asleep.length === 0) break;
    logger.warn(
      { orgId: job.orgId, jobId: job.id, attempt, providers: asleep.map(m => m.provider) },
      'architect_tool_server_unreachable_waiting',
    );
    await new Promise(resolve => setTimeout(resolve, MCP_WAKE_WAIT_MS));
    mcp = await listMcpToolsLive(job.orgId);
  }

  const unreachable = mcp.filter(m => m.error && m.error !== 'not connected');
  if (unreachable.length > 0) {
    throw new Error(
      `Could not read the tools from ${unreachable.map(m => m.provider).join(', ')} ` +
        `(${unreachable[0].error}). Designing an agent without them would quietly leave out things your ` +
        'org can already do, and list setup work you do not need — so nothing further was spent. ' +
        'Check the connector is online, then run this again.',
    );
  }
  // Every tool the org can actually call, read AFTER any cold start above.
  // The reviewer needs this to tell a real omission from a capability that
  // is already within reach.
  const mcpToolNames = [...new Set(mcp.flatMap(m => m.tools.map(t => t.name)))];
  // THE DESIGNER MUST BE ABLE TO READ WHAT THE VALIDATOR WILL CHECK.
  //
  // validateSpec compares every action against the capability manifest by
  // exact string, and the designer used to be handed only the Matcher's
  // prose. The spellings existed nowhere in its context, so it wrote the
  // ones it expected: `get_sobject_schema` for a server that publishes
  // `getObjectSchema`. Three attempts, three rejections, and a build that
  // had already been paid for. The names go in front of it now, from the
  // same read the manifest itself is built from.
  const mcpToolsByServer = mcp
    .filter(m => m.tools.length > 0)
    .map(m => ({ connector: m.provider, tools: m.tools.map(t => t.name) }));
  const crudObjects = objects
    .filter(o => (o.custom || CORE_OBJECTS.has(o.name)) && (o.createable || o.updateable || o.queryable))
    .slice(0, 120)
    .map(o => ({
      sobject: o.name,
      operations: [
        ...(o.createable ? ['create'] : []),
        ...(o.updateable ? ['update'] : []),
        ...(o.queryable ? ['query'] : []),
      ],
    }));

  // 2 — survey: the gather itself, shaped in code (survey-inventory.ts).
  // A model used to be paid to re-type this list.
  const surveyed = await stage<Record<string, unknown>>(
    job, 'survey', cp.surveyed,
    async () => inventoryFromGather({ objects, invocables, mcp, knowledgeBases: kbs, crud: crudObjects, coreObjects: CORE_OBJECTS }),
    () => ({ detail: `${found} things found` }),
    v => { cp.surveyed = v; },
  );
  const available: AvailableNames = {
    mcp: mcpToolsByServer,
    crud: crudObjects,
    invocables: invocables.map(i => ({ kind: i.kind, name: i.name })),
  };

  // 3 — match
  const match = await stage<MatchResult>(
    job, 'match', cp.match,
    () => specialist<MatchResult>(job, engine, 'match_capabilities', {
      capabilities: requirement.capabilities,
      orgInventory: surveyed,
    }),
    m => {
      const n = (m.partial?.length ?? 0) + (m.missing?.length ?? 0);
      return {
        state: n > 0 ? ('warn' as StepState) : ('done' as StepState),
        detail: n > 0 ? `${n} gap${n === 1 ? '' : 's'}` : 'full coverage',
      };
    },
    m => { cp.match = m; },
  );
  const gaps = (match.partial?.length ?? 0) + (match.missing?.length ?? 0);

  // 4 — design, with validation + estimator gates (≤3 rounds)
  // A customer waiting on WhatsApp abandons the conversation; an account
  // executive asking about their pipeline does not. The old internal target
  // was 8s, which a genuinely multi-specialist design cannot meet — and the
  // estimator's first lever when over budget is "collapse sub-agents".
  // Live result: a requirement that explicitly asked for specialists came
  // back as one flat agent with twelve tools, at $0.043 against a $0.15
  // cost target. Cost was never the constraint; the latency number alone
  // was deleting the architecture.
  const customer = /whatsapp|sms|customer|web chat/i.test(job.requirement + (requirement.trigger ?? ''));
  const targets = customer ? { costUsd: 0.06, latencySeconds: 4 } : { costUsd: 0.15, latencySeconds: 25 };
  let feedback = '';
  let overTarget = '';
  // Wiring the compiler had to repair. Surfaced in the result rather than
  // applied silently — a graph the customer did not draw must be visible.
  const wiringNotes: string[] = [];
  // A checkpointed spec that already has instructions belongs to the
  // prompts stage, not this one — only an un-prompted draft short-circuits
  // the design. `promptsDone` is what distinguishes them.
  //
  // But a saved spec is only reusable while it still VALIDATES. A build
  // that stopped on a late gate has a checkpoint holding the very spec that
  // failed, so restoring it unchanged replays the same failure for free and
  // the customer sees Resume do nothing — which is exactly what happened
  // when a rule the compiler enforced was missing from validateSpec. When
  // the saved spec no longer passes, the stage that owns the problem is
  // re-run instead of reused; the retry rounds and the Prompt Engineer then
  // get a chance to repair it.
  const checkpointErrors = cp.spec ? validateSpec(cp.spec, manifest) : [];
  if (cp.spec && checkpointErrors.length > 0) {
    logger.info(
      { jobId: job.id, errors: checkpointErrors.slice(0, 5).map(e => `${e.path}: ${e.message}`) },
      'architect_checkpoint_spec_invalid_rebuilding',
    );
  }
  const specStillValid = !!cp.spec && checkpointErrors.length === 0;
  const promptsAlreadyWritten = specStillValid && specHasPrompts(cp.spec!);
  // Set by the design stage when it patched a saved design whose prompts
  // had already been written: only what the patch touched needs text.
  let checkpointHadPrompts = false;
  const patchChangedIds: string[] = [];
  let spec = await stage<AgentSpec>(
    job, 'design', cp.spec,
    async () => {
      // A saved design that no longer validates is patched, not redrawn.
      let lastDraft: AgentSpec | null = cp.spec && !specStillValid ? cp.spec : null;
      checkpointHadPrompts = !!cp.spec && specHasPrompts(cp.spec);
      let lastErrors: SpecError[] = checkpointErrors;
      // The validator's findings are mechanical: a name, a missing field,
      // an operation. Re-emitting the whole design to fix them paid the
      // large tier's reasoning again for a graph that was mostly right,
      // three times over. Attempt 2 patches attempt 1 at low effort; if
      // the patch does not help, attempt 3 starts over.
      const patchedDesign = async (): Promise<AgentSpec | null> => {
        const answer = await specialist<unknown>(job, engine, 'design_flow', {
          requirement,
          currentDesign: lastDraft,
          validationErrors: lastErrors.map(e => `${e.path}: ${e.message}`),
          available,
          instruction: DESIGN_PATCH_INSTRUCTION,
        }, { rawJson: true, maxOutputTokens: 4000, effort: 'low' });
        if (!isSpecPatch(answer)) return null;
        const patched = applySpecPatch(lastDraft!, answer);
        if (lastDraft === cp.spec) patchChangedIds.push(...patched.changedIds);
        return patched.spec;
      };
      const fullDesign = () => specialist<AgentSpec>(job, engine, 'design_flow', {
        requirement,
        matched: match.matched,
        partial: match.partial,
        missing: match.missing,
        available,
        instruction: DESIGN_INSTRUCTION,
        ...(feedback ? { previousAttemptErrors: feedback } : {}),
      }, { rawJson: true, maxOutputTokens: 8000 });
      for (let attempt = 1; attempt <= 3; attempt++) {
        const patchable = lastDraft !== null && (attempt === 2 || (attempt === 1 && lastDraft === cp.spec));
        const draft = patchable ? (await patchedDesign()) ?? await fullDesign() : await fullDesign();
        // A shapeless answer is a retryable mistake, not a crash. The model
        // can return prose, a wrapper object, or a truncated spec; each of
        // those used to take the whole build down inside the repair below.
        // Caught here it costs one more attempt and the model is told what
        // was wrong.
        if (!Array.isArray(draft?.nodes) || !Array.isArray(draft?.edges)) {
          feedback = 'The answer was not an AgentSpec: it must be ONE JSON object with a `nodes` array and an ' +
            '`edges` array at the top level, not wrapped in another key and not prose.';
          if (attempt === 3) throw new Error('The design never came back as an AgentSpec after 3 attempts.');
          continue;
        }
        // Free, deterministic repairs before the paid one. A missing edge
        // is not a judgement call (attachOrphansToRoot); neither is the
        // spelling of a name the Surveyor already reported (repairNames).
        wiringNotes.push(...attachOrphansToRoot(draft));
        wiringNotes.push(...repairNames(draft, available));
        const errors = validateSpec(draft, manifest);
        if (errors.length > 0) {
          feedback = errors.map(e => `${e.path}: ${e.message}`).join('\n');
          lastDraft = draft;
          lastErrors = errors;
          if (attempt === 3) throw new Error('The design would not validate after 3 attempts:\n' + feedback);
          continue;
        }
        // BUDGET IS ADVICE; CORRECTNESS IS NOT.
        //
        // A validation error means the design is wrong, and gets all three
        // attempts. Being over target means the design is expensive, which
        // is a different kind of problem and must never be solved by
        // shipping an agent that does less than was asked for. So an
        // overage buys ONE re-emit, and only when COST breached — a design
        // that is merely slower than hoped is accepted and labelled, not
        // rewritten. The previous behaviour spent every remaining attempt
        // optimising latency and returned an agent missing its specialists.
        const est = estimateSpec(draft, targets);
        const costBreached = est.warmUsd > (targets.costUsd ?? Infinity);
        if (!est.withinBudget && costBreached && attempt === 1) {
          feedback =
            `The design is over the COST target (warm $${est.warmUsd.toFixed(3)} vs $${targets.costUsd}). ` +
            'Re-emit it cheaper WITHOUT dropping any capability the requirement asked for — if the only way ' +
            'to hit the target is to remove something the client asked for, keep the capability and stay ' +
            'over target. Levers:\n- ' + est.levers.join('\n- ');
          continue;
        }
        if (!est.withinBudget) {
          overTarget = costBreached
            ? `over cost target: $${est.warmUsd.toFixed(3)}/run`
            : `${est.latencySeconds}s per reply`;
        }
        return draft;
      }
      throw new Error('No valid design produced.');
    },
    d => ({
      // A cosmetic one-liner must never be the thing that fails a build.
      detail: overTarget ||
        `${(d.nodes ?? []).filter(n => n.type === 'subagent').length} helper(s), ${(d.nodes ?? []).filter(n => n.type === 'tool').length} tool(s)`,
    }),
    d => { cp.spec = d; },
  );

  // 5 — prompts
  // The Prompt Engineer answers with the texts, keyed by node id, and the
  // merge happens here (spec-merge.ts). It used to return the whole spec
  // with the texts inside — up to 12,000 output tokens, minutes of
  // generation, and edges it could drop on the way.
  const writePrompts = async (target: AgentSpec, onlyIds: string[] | null, firstFeedback: string): Promise<void> => {
    let promptFeedback = firstFeedback;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const writeFor = target.nodes
        .filter(n => (n.type === 'agent' || n.type === 'subagent' || n.type === 'tool') && (!onlyIds || onlyIds.includes(n.id)))
        .map(n => n.id);
      const answer = await specialist<unknown>(job, engine, 'write_prompts', {
        draftSpec: target,
        requirement,
        writeFor,
        instruction:
          'Return ONE JSON object and nothing else: {"instructions": {"<nodeId>": "<text>"}, "descriptions": {"<nodeId>": "<text>"}}. ' +
          'instructions has one entry for every agent and sub-agent node in writeFor; descriptions has one entry for every ' +
          'tool node in writeFor. Node ids exactly as in draftSpec. Do not return the spec itself.',
        ...(promptFeedback ? { previousAttemptErrors: promptFeedback } : {}),
      }, { rawJson: true, maxOutputTokens: 8_000 });
      const merged = applyPromptMap(target, answer);
      const stillMissing = merged.missing.filter(m => !onlyIds || onlyIds.includes(m.split(' ')[0]));
      const errors = validateSpec(target, manifest);
      if (errors.length === 0 && (stillMissing.length === 0 || attempt === 3)) {
        if (stillMissing.length > 0) logger.warn({ jobId: job.id, stillMissing }, 'architect_prompts_incomplete');
        return;
      }
      promptFeedback = [
        ...errors.map(e => `${e.path}: ${e.message}`),
        ...(stillMissing.length ? [`No text was written for: ${stillMissing.join(', ')}`] : []),
        ...(merged.unknownIds.length ? [`These ids are not in draftSpec: ${merged.unknownIds.join(', ')}`] : []),
      ].join('\n');
      if (attempt === 3) throw new Error('The instructions would not validate after 3 attempts:\n' + promptFeedback);
    }
  };
  spec = await stage<AgentSpec>(
    job, 'prompts', promptsAlreadyWritten ? cp.spec : undefined,
    async () => {
      // A fresh design carries the designer's placeholder instructions,
      // which are not prompts: everything is written. Only a patched
      // checkpoint whose prompts were already written keeps them, and
      // then just what the patch touched (plus anything empty) is written.
      // The first measured build skipped this stage outright because the
      // placeholders counted as text — the agent shipped without prompts.
      const empty = spec.nodes.filter(needsText).map(n => n.id);
      const only = checkpointHadPrompts && patchChangedIds.length > 0 ? [...new Set([...patchChangedIds, ...empty])] : null;
      if (only && only.length === 0) return spec;
      await writePrompts(spec, only, '');
      return spec;
    },
    () => ({ detail: 'instructions written' }),
    v => { cp.spec = v; },
  );

  // 6 — review: does this agent actually do what was asked?
  //
  // Nothing checked this before, and things went missing silently — an
  // explicit approval requirement produced no approval gate, and a
  // requirement asking for specialists came back as one flat agent. Both
  // shipped as successes. Every other gate here asks "is this spec VALID",
  // which a wrong agent passes easily.
  //
  // The Evaluator judges against the REQUIREMENT and never sees the
  // builders' reasoning, so it cannot be talked round by a design that
  // explains itself well. A `fail` buys one repair round: the design is
  // re-emitted with the Evaluator's own fix list, re-prompted, and
  // re-judged. This costs real money on every build — which is the trade
  // the client asked for explicitly, because an agent that is quietly
  // wrong is worth less than nothing to the customer who receives it.
  const review = await stage<ReviewResult>(
    // A verdict on a spec that has since been rebuilt is not a verdict on
    // this one. Re-judge rather than carry a stale pass forward.
    job, 'review', specStillValid ? cp.review : undefined,
    async () => {
      // A REVIEW WITHOUT A VERDICT IS AN UNCLEAR REVIEW, NOT A CRASH.
      //
      // The Evaluator's schema is not strict — optional fields really are
      // optional — so it can answer without `verdict`. Everything after
      // this read it as a string, and a summary line doing
      // verdict.replace() killed a build that had already designed and
      // prompted the agent. Normalised once, here, where it is produced.
      const judged = async (): Promise<ReviewResult> => {
        let r = await judgeRaw();
        // gpt-5.5 through non-strict structured output leaves `verdict` out
        // now and then although the schema requires it -- a review that
        // cost $0.035 and 32 s then said "unclear" and gated nothing. When
        // the rest of the answer is there, the verdict follows from it:
        // something named as missing is a fail, nothing named is a pass.
        // An answer with no shape at all is asked for once more.
        if (!r?.verdict && !(Array.isArray(r?.failures) && Array.isArray(r?.fixes))) {
          logger.warn({ jobId: job.id }, 'architect_review_shapeless_retrying');
          r = await judgeRaw();
        }
        const named = (r?.uncovered?.length ?? 0) + (r?.fixes?.length ?? 0) + (r?.failures?.length ?? 0);
        const derived: ReviewResult['verdict'] = named > 0 ? 'fail' : 'pass';
        return { ...r, verdict: r?.verdict ?? (Array.isArray(r?.failures) || Array.isArray(r?.fixes) ? derived : 'unclear') } as ReviewResult;
      };
      const judgeRaw = (): Promise<ReviewResult> =>
        specialist<ReviewResult>(job, engine, 'evaluate', {
          requirement,
          design: summariseForReview(spec, mcpToolNames),
          instruction:
            'Judge this DESIGN against the requirement. For every capability, successCriteria entry and ' +
            'explicit rule in the requirement, decide whether some node, edge, tool or approval setting ' +
            'actually delivers it. List anything the design does NOT deliver in `uncovered`, quoting the ' +
            'requirement\'s own words. Treat a stated approval or permission rule with no corresponding ' +
            'approval setting as uncovered.\n' +
            'IF THE REQUIREMENT IS A SCRIPT — numbered steps, example wording, a table of statuses — the right tools are not enough. Read the agent\'s own instructions and check they carry the order, what makes each answer valid, what happens when it is not, which field each step writes, and EVERY status transition the client named. A design with the correct tools and no script does not deliver a scripted requirement: report each missing step as uncovered.\n' +
            'Check too that options the client said come from configured data are READ at runtime rather than written into the prompt, and that a dependent picklist is read as a pair.\n' +
            'Verdict `fail` only when something the client explicitly asked ' +
            'for is absent — not for style, naming or efficiency.',
        });

      const first = await judged();
      // What triggers a repair is the UNCOVERED LIST, not the verdict.
      // Gating on `fail` alone shipped an agent with five things the client
      // asked for missing, because the Evaluator named all five and still
      // returned a softer verdict — the omissions were reported and then
      // acted on by nobody. A named omission is a defect whatever adjective
      // accompanies it.
      const somethingMissing = !!(first.uncovered?.length || first.fixes?.length);
      const badVerdict = first.verdict === 'fail' || first.verdict === 'blocked';
      if (!somethingMissing && !badVerdict) return first;

      // One repair round, using the Evaluator's own findings as the brief.
      const brief =
        'A review found this design does not deliver part of the requirement. Fix exactly these and ' +
        'change nothing else:\n' +
        [...(first.uncovered ?? []).map(u => `MISSING: ${u}`),
         ...(first.fixes ?? []).map(f => JSON.stringify(f))].join('\n');

      // The repair is a patch to the design that exists, at the designer's
      // full effort — this is judgement, not spelling — and then texts for
      // what the patch touched. The whole graph used to be re-emitted and
      // re-prompted for a fix the Evaluator had already named.
      const answer = await specialist<unknown>(job, engine, 'design_flow', {
        requirement,
        currentDesign: spec,
        available,
        previousAttemptErrors: brief,
        instruction:
          DESIGN_PATCH_INSTRUCTION +
          ' Keep everything that already works. Set approval.required on any tool the requirement says needs human approval.',
      }, { rawJson: true, maxOutputTokens: 6000 });
      if (!isSpecPatch(answer)) return { ...first, repaired: false };
      const patched = applySpecPatch(spec, answer);
      wiringNotes.push(...attachOrphansToRoot(patched.spec));
      wiringNotes.push(...repairNames(patched.spec, available));

      // Only adopt the repair if it is actually valid — a fix that will not
      // compile is worse than the flaw it was meant to correct.
      if (validateSpec(patched.spec, manifest).length > 0) return { ...first, repaired: false };
      const touched = patched.spec.nodes.filter(n => patched.changedIds.includes(n.id) || needsText(n)).map(n => n.id);
      if (touched.length > 0) {
        try {
          await writePrompts(patched.spec, touched, '');
        } catch (err) {
          logger.warn({ jobId: job.id, err: err instanceof Error ? err.message : String(err) }, 'architect_repair_prompts_failed');
          return { ...first, repaired: false };
        }
      }
      spec = patched.spec;
      cp.spec = patched.spec;
      const second = await judged();
      return { ...second, repaired: true };
    },
    r => ({
      state: r.verdict === 'pass' ? ('done' as StepState) : ('warn' as StepState),
      detail: r.verdict === 'pass'
        ? 'covers everything asked'
        : r.uncovered?.length
          ? `${r.uncovered.length} not covered`
          // Cosmetic. It must never be the thing that fails a build.
          : (r.verdict ?? 'unclear').replace(/_/g, ' '),
    }),
    r => { cp.review = r; },
  );

  // 7 — gaps
  guardStop(job, 'gaps');
  let s = step(job, 'gaps');
  s.state = 'running';
  // Normalised on the RESTORE path too, not just when freshly written: a
  // build checkpointed before this coercion existed holds the raw shape,
  // and resuming it would otherwise replay the exact failure it stopped on.
  let prerequisites: SpecPrerequisite[] = normalizePrerequisites(cp.prerequisites ?? []);
  if (gaps > 0 && !cp.prerequisites) {
    const gapOut = await specialist<{ prerequisites: SpecPrerequisite[]; blockingCount?: number }>(
      job, engine, 'report_gaps',
      {
        partial: match.partial,
        missing: match.missing,
        orgInventory: surveyed,
        specNodes: spec.nodes.map(n => n.id),
        instruction:
          `Write ONE prerequisite for EVERY item in partial and missing — ${gaps} in total. ` +
          'Never omit one because the design worked around it; a gap the client is not told about is the ' +
          'worst outcome this system can produce.\n\n' +
          'Each prerequisite is an object with EXACTLY these keys and no others:\n' +
          '  id       — "PRE-001", "PRE-002", … in order\n' +
          '  kind     — one of: invocable_apex | flow | field | permission | connector | ' +
          'knowledge_base | record_type | named_credential | data\n' +
          '  title    — what is missing, under 120 characters\n' +
          '  why      — what the agent cannot do without it, in the admin\'s words\n' +
          '  steps    — an array of strings; what a Salesforce admin actually does\n' +
          '  assignee — one of: salesforce_admin | apex_developer | integration_owner | ' +
          'data_owner | business_owner\n' +
          '  blocking — true if the agent cannot go live without it\n' +
          '  status   — always "pending"\n' +
          'Optionally: verification, affects (node ids), estimatedEffort (minutes|hours|days).\n\n' +
          'A prerequisite is something missing from the CLIENT\'S ORG that they must supply: a Flow, an ' +
          'invocable Apex action, a field, a record type, a permission, a connector, a knowledge base, or ' +
          'data. NEVER write one for work this platform already does — routing between specialists and ' +
          'merging their answers, choosing or enforcing the AI provider and model, conversation memory and ' +
          'context, the approval gate, or writing the agent\'s instructions. Telling a client to build any ' +
          'of those tells them to rebuild the product they are using.',
      },
    );
    // Coerced, not trusted. The writer is not given the spec schema, so its
    // field names drift — and this list is validated against
    // `additionalProperties: false` at the final gate, where a mismatch used
    // to destroy a fully paid-for build. See normalizePrerequisites.
    prerequisites = normalizePrerequisites(gapOut.prerequisites);

    // The architecture's hardest promise is that nothing is silently
    // dropped. If the writer returned fewer items than there are gaps,
    // the shortfall is recorded mechanically rather than lost — an
    // unpolished prerequisite beats an invisible one.
    if (prerequisites.length < gaps) {
      const covered = new Set(
        prerequisites.flatMap(p => [p.title?.toLowerCase(), ...(p.affects ?? [])].filter(Boolean) as string[]),
      );
      const allGaps = [...(match.partial ?? []), ...(match.missing ?? [])];
      let seq = prerequisites.length + 1;
      for (const g of allGaps) {
        const label = String(
          (g as Record<string, unknown>).capability ??
            (g as Record<string, unknown>).name ??
            (g as Record<string, unknown>).title ??
            'Unnamed capability',
        );
        if (covered.has(label.toLowerCase())) continue;
        if (prerequisites.some(p => (p.title ?? '').toLowerCase().includes(label.toLowerCase().slice(0, 24)))) continue;
        const reason = String(
          (g as Record<string, unknown>).reason ?? (g as Record<string, unknown>).why ?? 'The org has nothing that does this yet.',
        );
        prerequisites.push({
          id: `PRE-${String(seq++).padStart(3, '0')}`,
          kind: 'permission',
          title: label.slice(0, 120),
          why: reason.slice(0, 500),
          steps: [
            `Decide who owns "${label}" in your org and what should provide it.`,
            'Tell Archon once it exists and the agent will be re-checked automatically.',
          ],
          assignee: 'salesforce_admin',
          blocking: true,
          status: 'pending',
          estimatedEffort: 'hours',
        });
      }
      logger.warn(
        { jobId: job.id, gaps, written: gapOut.prerequisites?.length ?? 0, total: prerequisites.length },
        'architect_gap_shortfall_backfilled',
      );
    }
  }
  const blockingCount = prerequisites.filter(p => p.blocking && p.status !== 'done' && p.status !== 'waived').length;
  spec.prerequisites = prerequisites;
  spec.lifecycle = { state: blockingCount > 0 ? 'blocked' : 'draft', version: 1 };
  cp.prerequisites = prerequisites;
  cp.spec = spec;
  s.state = 'done';
  s.reused = s.reused ?? false;
  s.detail = blockingCount > 0 ? `${blockingCount} blocking` : prerequisites.length > 0 ? `${prerequisites.length} optional` : 'nothing missing';
  await saveJob(job);

  // 7 — compile (deterministic; writes Archon records only)
  // Never short-circuited by the checkpoint: it is the one stage that
  // writes Salesforce records, and a resumed build that skipped it would
  // report success having created nothing.
  guardStop(job, 'compile');
  s = step(job, 'compile');
  s.state = 'running';
  const compileStartedAt = Date.now();
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
  s.ms = Date.now() - compileStartedAt;
  s.costUsd = 0;

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
    // Anything the review found missing leads the notes. A customer must
    // meet a shortfall before they meet the agent, not after.
    notes: [
      ...(review.uncovered ?? []).map(u => `NOT COVERED — you asked for this and the design does not do it: ${u}`),
      ...wiringNotes,
      ...compiled.notes,
      ...(review.repaired ? ['A review found gaps against your description; the design was rebuilt once to close them.'] : []),
    ],
    review,
    confidence: buildConfidence(requirement, match, prerequisites, review),
  };
  job.status = 'done';
  job.finishedAt = Date.now();
  await saveJob(job);
  logger.info(
    {
      jobId: job.id, orgId: job.orgId, agentId: compiled.agentId,
      costUsd: Number(job.costUsd.toFixed(4)),
      chainCostUsd: Number((job.priorCostUsd + job.costUsd).toFixed(4)),
      resumedFrom: job.resumedFrom,
      ms: Date.now() - job.startedAt,
    },
    'architect_build_done',
  );
}

/**
 * The design as something to be judged, not as JSON to be admired.
 *
 * Deliberately omits the instructions the builders wrote: the Evaluator's
 * whole value is that it cannot be persuaded by a design that explains
 * itself well, and prose arguing why an omission was reasonable is exactly
 * what would persuade it. What it gets is the shape — who exists, what is
 * wired to what, which tools are real, and which writes are gated.
 */
function summariseForReview(spec: AgentSpec, catalogTools: string[]): Record<string, unknown> {
  const byId = new Map(spec.nodes.map(n => [n.id, n]));
  return {
    trigger: spec.trigger,
    agents: spec.nodes
      .filter(n => n.type === 'agent' || n.type === 'subagent')
      .map(n => ({ id: n.id, role: n.type, label: n.label, whenToUse: n.description ?? null })),
    tools: spec.nodes
      .filter(n => n.type === 'tool')
      .map(n => ({
        id: n.id,
        label: n.label,
        does: n.description ?? null,
        calls: n.action?.toolName ?? `${n.action?.operation ?? '?'} ${n.action?.sobject ?? ''}`.trim(),
        // The field an unenforced approval rule hides in.
        requiresHumanApproval: n.approval?.required === true,
      })),
    // The catalog's OWN tool names, not just its label. Without them the
    // reviewer cannot tell that the agent can already identify the current
    // user or describe an object, and reports capabilities as missing that
    // are sitting right there — which now costs a repair round chasing a
    // gap that does not exist.
    toolCatalogs: spec.nodes.filter(n => n.type === 'tool_catalog').map(n => n.label),
    // What a catalog node actually puts within reach. Without this the
    // reviewer cannot tell that the agent can already identify the current
    // user or describe an object, and reports capabilities as missing that
    // are sitting right there — which now costs a repair round chasing a
    // gap that does not exist.
    toolsReachableViaCatalog: catalogTools,
    wiring: spec.edges.map(e => ({
      from: byId.get(e.from)?.label ?? e.from,
      to: byId.get(e.to)?.label ?? e.to,
      mode: e.mode,
    })),
  };
}

/**
 * Has the Prompt Engineer already been over this spec?
 *
 * The design and prompt stages share one checkpoint slot, because the
 * second returns the first's spec with its instructions filled in. Without
 * this test a resume would restore the prompted spec into the DESIGN stage
 * and then pay to write the prompts a second time — the exact waste the
 * checkpoint exists to prevent.
 */
function specHasPrompts(spec: AgentSpec): boolean {
  return spec.nodes.some(
    n => (n.type === 'agent' || n.type === 'subagent') && (n.instructions ?? '').trim().length > 0,
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

function buildConfidence(
  req: Requirement,
  match: MatchResult,
  prereqs: SpecPrerequisite[],
  review?: ReviewResult,
): string {
  const parts: string[] = [];
  // The review's verdict leads: it is the only signal here derived from
  // comparing the finished agent to what was actually asked for.
  if (review && review.verdict !== 'pass') {
    parts.push(
      review.uncovered?.length
        ? `a review found ${review.uncovered.length} thing(s) you asked for that this design does not do — read the notes before going live`
        : `a review returned '${(review.verdict ?? 'unclear').replace(/_/g, ' ')}'`,
    );
  }
  if (req.openQuestions?.length) parts.push(`I assumed: ${req.openQuestions[0]}`);
  if ((match.partial?.length ?? 0) > 0) {
    parts.push('the partial capability matches are where I am least sure — read the named matches before going live');
  }
  if (prereqs.some(p => p.blocking)) parts.push('nothing runs until the blocking setup items are done');
  if (parts.length === 0) parts.push('the requirement was specific and everything matched — the main risk is untested edge cases until the test phase runs');
  return parts.join('; ') + '.';
}

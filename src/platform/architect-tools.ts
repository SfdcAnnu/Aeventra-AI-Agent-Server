/**
 * The Architect as tools — one per pipeline stage, so an agent can run a
 * build stage by stage and talk to the person in between ("your org has
 * no email action — add one, or skip the notification?") instead of the
 * all-or-nothing run the build screen does.
 *
 * Each stage tool runs the SAME checkpointed build job up to its stage
 * (`stopAfter`) and returns that stage's result. Nothing about the
 * pipeline is re-implemented here: the job pauses after the stage exactly
 * as it pauses at a cost ceiling, and the next stage tool resumes it.
 */
import { z } from 'zod';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { createBuildJob, resumeBuildJob, getBuildJob, listResumableBuilds, deleteBuild, type BuildJob } from '../architect/build-job';
import { rewritePrompt } from '../architect/assistant';
import { define, ok, fail, clip } from './tool-kit';

/** How long a stage tool waits for its stage before handing back "still
 *  running" — inside the runtime's tool-call budget with room to spare. */
const WAIT_MS = 48_000;
const POLL_MS = 700;

const STAGE_TOOL: Array<[key: string, tool: string, title: string, description: string, next: string]> = [
  ['understand', 'analyze_requirement', 'Analyze requirement', 'Start an Architect build from a requirement and stop after the first stage: what is being asked, the capabilities it needs, and the open questions. Returns a jobId every later stage tool takes. Ask the person the open questions before going on.', 'inspect_org'],
  ['survey', 'inspect_org', 'Inspect the org', 'Continue the build through the org survey: objects, fields, tools, Flows and invocable Apex the org already has, as a capability manifest.', 'find_gaps'],
  ['match', 'find_gaps', 'Find gaps', 'Continue the build through matching: what the requirement needs that the org already has, what it lacks, and what the person must set up. Confirm gaps with the person before designing.', 'design_agent'],
  ['design', 'design_agent', 'Design the agent', 'Continue the build through design: the root, specialists, tools and approvals as a spec. Returns the shape so it can be shown before instructions are written.', 'write_instructions'],
  ['prompts', 'write_instructions', 'Write instructions', 'Continue the build through prompt writing: instructions and few-shot examples for every node.', 'review_design'],
  ['review', 'review_design', 'Review the design', 'Continue the build through the evaluator: the design judged against the requirement, with anything uncovered listed (a repair round runs when needed).', 'save_agent'],
  ['compile', 'save_agent', 'Save the agent', 'Finish the build: list the outstanding setup, compile the spec and save the agent as a Draft in the org. Returns the agent API name and the summary.', ''],
];

function stageSummary(job: BuildJob, key: string): Record<string, unknown> {
  const cp = job.checkpoint ?? {};
  switch (key) {
    case 'understand': return { requirement: cp.requirement ?? null };
    case 'survey': {
      const s = (cp.surveyed ?? {}) as Record<string, unknown>;
      const trimmed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s)) trimmed[k] = Array.isArray(v) ? { count: v.length, first: v.slice(0, 20) } : v;
      return { surveyed: trimmed };
    }
    case 'match': return { match: cp.match ?? null };
    case 'design': {
      const spec = cp.spec as { nodes?: Array<Record<string, unknown>> } | undefined;
      return { design: spec ? { nodes: (spec.nodes ?? []).map(n => ({ type: n.type, name: n.name, tools: Array.isArray(n.tools) ? n.tools.length : undefined, approval: (n as { approval?: { required?: boolean } }).approval?.required ?? false })) } : null };
    }
    case 'prompts': {
      const spec = cp.spec as { nodes?: Array<Record<string, unknown>> } | undefined;
      return { prompts: (spec?.nodes ?? []).map(n => ({ name: n.name, instructionChars: typeof n.instructions === 'string' ? n.instructions.length : 0 })) };
    }
    case 'review': return { review: cp.review ?? null };
    case 'compile': return { result: job.result ?? null, prerequisites: cp.prerequisites ?? [] };
    default: return {};
  }
}

function view(job: BuildJob, key: string, next: string): Record<string, unknown> {
  const done = job.status === 'paused' || job.status === 'done' || job.status === 'failed';
  return {
    jobId: job.id,
    status: job.status,
    stage: key,
    steps: job.steps.map(s => ({ key: s.key, label: s.label, state: s.state, detail: clip(s.detail, 300), costUsd: s.costUsd ?? 0 })),
    costUsd: Number((job.priorCostUsd + job.costUsd).toFixed(4)),
    maxCostUsd: job.maxCostUsd,
    ...(done ? stageSummary(job, key) : {}),
    error: job.status === 'failed' ? job.error : undefined,
    next: !done ? `still running — call get_build_status with this jobId, then ${next || 'stop'}` : job.status === 'failed' ? 'fix what the error says, or resume_build to retry from the checkpoint' : next ? `when the person agrees, call ${next} with this jobId` : 'done — the agent is saved as a Draft',
  };
}

async function waitFor(jobId: string, orgId: string): Promise<BuildJob | undefined> {
  const until = Date.now() + WAIT_MS;
  let job = await getBuildJob(jobId, orgId);
  while (job && (job.status === 'queued' || job.status === 'running') && Date.now() < until) {
    await new Promise(r => setTimeout(r, POLL_MS));
    job = await getBuildJob(jobId, orgId);
  }
  return job;
}

const analyzeRequirement = define({
  name: 'analyze_requirement',
  title: STAGE_TOOL[0][2],
  description: STAGE_TOOL[0][3],
  inputSchema: {
    requirement: z.string().min(20).max(12_000).describe('What the agent should do, in the person\'s words — two or three full sentences at least.'),
    attachmentText: z.string().max(60_000).optional().describe('Text of a document the person provided, if any.'),
  },
  readOnly: false,
  handler: async ({ requirement, attachmentText }, p) => {
    const job = createBuildJob(p.orgId, requirement, { attachmentText, stopAfter: 'understand' });
    const done = await waitFor(job.id, p.orgId);
    return ok(view(done ?? job, 'understand', 'inspect_org'));
  },
});

const continueTools = STAGE_TOOL.slice(1).map(([key, name, title, description, next]) =>
  define({
    name,
    title,
    description,
    inputSchema: { jobId: z.string().min(1).describe('The build job from analyze_requirement.') },
    readOnly: false,
    handler: async ({ jobId }, p) => {
      const prior = await getBuildJob(jobId, p.orgId);
      if (!prior) return fail(`No build job ${jobId} for this org.`);
      if (prior.status === 'running' || prior.status === 'queued') return ok(view(prior, key, next));
      if (prior.status === 'done') return ok({ ...view(prior, 'compile', ''), note: 'This build already finished.' });
      const job = await resumeBuildJob(p.orgId, jobId, undefined, key === 'compile' ? undefined : key);
      if (!job) return fail(`Build ${jobId} cannot be resumed (status ${prior.status}${prior.error ? `: ${prior.error}` : ''}).`);
      const done = await waitFor(job.id, p.orgId);
      return ok(view(done ?? job, key, next));
    },
  }),
);

const getBuildStatus = define({
  name: 'get_build_status',
  title: 'Build status',
  description: 'The current state of an Architect build: every stage, its detail and cost, and the result once saved.',
  inputSchema: { jobId: z.string().min(1) },
  readOnly: true,
  handler: async ({ jobId }, p) => {
    const job = await getBuildJob(jobId, p.orgId);
    if (!job) return fail(`No build job ${jobId} for this org.`);
    const last = [...job.steps].reverse().find(s => s.state === 'done' || s.state === 'warn')?.key ?? 'understand';
    return ok(view(job, last, ''));
  },
});

const listResumable = define({
  name: 'list_resumable_builds',
  title: 'Resumable builds',
  description: 'Builds that stopped with their work saved — paused at a stage or at the cost ceiling — and can be resumed without paying again for finished stages.',
  inputSchema: {},
  readOnly: true,
  handler: async (_a, p) => {
    const builds = await listResumableBuilds(p.orgId, 10);
    return ok({ builds: builds.map(b => ({ jobId: b.id, requirement: clip(b.requirement, 200), status: b.status, stagesDone: b.steps.filter(s => s.state === 'done').length, stagesTotal: b.steps.length, costUsd: Number((b.priorCostUsd + b.costUsd).toFixed(4)), startedAt: new Date(b.startedAt).toISOString(), stale: b.stale ?? false })) });
  },
});

const resumeBuild = define({
  name: 'resume_build',
  title: 'Resume a build',
  description: 'Continue a paused or failed build from its checkpoint to the end. Finished stages are not paid for again.',
  inputSchema: { jobId: z.string().min(1), maxCostUsd: z.number().min(0.1).max(50).optional().describe('New ceiling for the whole chain; default is what was spent plus $2.') },
  readOnly: false,
  handler: async ({ jobId, maxCostUsd }, p) => {
    const job = await resumeBuildJob(p.orgId, jobId, maxCostUsd);
    if (!job) return fail(`Build ${jobId} cannot be resumed — it is not paused, and has no saved design to resume from.`);
    const done = await waitFor(job.id, p.orgId);
    return ok(view(done ?? job, 'compile', ''));
  },
});

const discardBuild = define({
  name: 'discard_build',
  title: 'Discard a build',
  description: 'Delete a paused or failed build and its checkpoint. Nothing in the org changes.',
  inputSchema: { jobId: z.string().min(1) },
  readOnly: false,
  handler: async ({ jobId }, p) => {
    const gone = await deleteBuild(p.orgId, jobId);
    return gone ? ok({ deleted: jobId }) : fail(`No build job ${jobId} for this org.`);
  },
});

const rewrite = define({
  name: 'rewrite_prompt',
  title: 'Rewrite instructions',
  description: 'Rewrite a draft of an agent\'s instructions, a specialist\'s instructions, or a tool\'s routing description in the platform\'s house style. Returns the rewrite and what changed; nothing is saved.',
  inputSchema: {
    draft: z.string().min(1).max(12_000),
    role: z.enum(['agent', 'subagent', 'tool']).default('agent'),
    agentName: z.string().max(120).optional(),
    department: z.string().max(60).optional(),
    toolNames: z.array(z.string().max(80)).max(40).optional(),
  },
  readOnly: true,
  handler: async (args, p) => {
    const conn = await getOrgConnection(p.orgId);
    const out = await rewritePrompt(conn, { ...args, modelId: '' });
    return ok({ instructions: out.instructions, changed: out.changed, costUsd: Number(out.costUsd.toFixed(4)) });
  },
});

export const ARCHITECT_TOOLS = [analyzeRequirement, ...continueTools, getBuildStatus, listResumable, resumeBuild, discardBuild, rewrite];

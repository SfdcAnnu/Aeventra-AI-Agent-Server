/**
 * Agent Architect routes — the async build path behind "Describe what you
 * need". A build far exceeds a chat turn, so POST starts a background job
 * and the Building screen polls GET until it lands.
 *
 *   POST /api/architect/build   { requirement, attachmentText?, maxCostUsd? }
 *     → 202 { jobId }
 *   POST /api/architect/build   { resumeJobId, maxCostUsd? }
 *     → 202 { jobId }   — continues a paused build from its checkpoint,
 *                         re-running only the stages that never finished
 *   GET  /api/architect/build/:jobId
 *     → { status, steps, costUsd, result?, error? }
 *   GET  /api/architect/builds/resumable
 *     → { builds: [...] }  — paused builds this org can still continue
 *
 * The requirement is untrusted input end to end: the Analyst treats it as
 * such, no specialist holds write scope, and the only writer (the
 * compiler) writes Archon records only.
 */
import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../auth/session';
import { logger } from '../logger';
import { createBuildJob, getBuildJob, resumeBuildJob, listResumableBuilds, type BuildJob } from '../architect/build-job';
import { rewritePrompt, copilotTurn } from '../architect/assistant';
import { getOrgConnection } from '../salesforce/per-org-connection';

export const architectRouter = Router();

// Either start a new build, or continue a paused one. `resumeJobId` makes
// it the latter; the requirement then comes from the paused build rather
// than the caller, so it cannot drift from the design already paid for.
const buildSchema = z.union([
  z.object({
    resumeJobId: z.string().uuid(),
    maxCostUsd: z.number().min(0.1).max(50).optional(),
  }),
  z.object({
    requirement: z.string().min(20, 'Describe the agent in at least a sentence or two.').max(20_000),
    attachmentText: z.string().max(200_000).nullish(),
    maxCostUsd: z.number().min(0.1).max(50).optional(),
  }),
]);

/** What the Building screen polls. `costUsd` is the CHAIN total — what this
 *  build has cost the customer across every resume — because that, not the
 *  current run's share, is the number the ceiling governs. */
function view(job: BuildJob): Record<string, unknown> {
  return {
    jobId: job.id,
    status: job.status,
    steps: job.steps,
    costUsd: Number((job.priorCostUsd + job.costUsd).toFixed(4)),
    thisRunCostUsd: Number(job.costUsd.toFixed(4)),
    maxCostUsd: job.maxCostUsd,
    resumedFrom: job.resumedFrom,
    resumable: job.status === 'paused',
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    result: job.result,
    error: job.error,
  };
}

architectRouter.post('/api/architect/build', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const parsed = buildSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }

  if ('resumeJobId' in parsed.data) {
    const job = await resumeBuildJob(orgId, parsed.data.resumeJobId, parsed.data.maxCostUsd);
    if (!job) {
      res.status(404).json({
        error: 'not_resumable',
        message: 'That build is not paused — only a build stopped at its budget ceiling can be continued.',
      });
      return;
    }
    logger.info(
      { orgId, jobId: job.id, resumedFrom: job.resumedFrom, alreadySpentUsd: job.priorCostUsd, maxCostUsd: job.maxCostUsd },
      'architect_build_resumed',
    );
    res.status(202).json({ jobId: job.id, resumedFrom: job.resumedFrom });
    return;
  }

  const job = createBuildJob(orgId, parsed.data.requirement, {
    attachmentText: parsed.data.attachmentText ?? undefined,
    maxCostUsd: parsed.data.maxCostUsd,
  });
  logger.info({ orgId, jobId: job.id, maxCostUsd: job.maxCostUsd }, 'architect_build_started');
  res.status(202).json({ jobId: job.id });
});

architectRouter.get('/api/architect/builds/resumable', sessionAuth, async (req, res) => {
  const builds = await listResumableBuilds(req.orgId!);
  res.json({
    builds: builds.map(b => ({
      jobId: b.id,
      requirement: b.requirement.slice(0, 300),
      costUsd: Number((b.priorCostUsd + b.costUsd).toFixed(4)),
      maxCostUsd: b.maxCostUsd,
      stagesDone: b.steps.filter(s => s.state === 'done' || s.state === 'warn').length,
      stagesTotal: b.steps.length,
      startedAt: new Date(b.startedAt).toISOString(),
    })),
  });
});

architectRouter.get('/api/architect/build/:jobId', sessionAuth, async (req, res) => {
  const job = await getBuildJob(req.params.jobId, req.orgId!);
  if (!job) {
    res.status(404).json({ error: 'build_not_found' });
    return;
  }
  res.json(view(job));
});

// ── ✦ Rewrite an instruction, for the model that will run it ─────────
const rewriteSchema = z.object({
  draft: z.string().min(1).max(12_000),
  role: z.enum(['agent', 'subagent', 'tool']).default('agent'),
  modelId: z.string().max(80).default(''),
  agentName: z.string().max(120).optional(),
  department: z.string().max(60).optional(),
  channel: z.string().max(40).optional(),
  toolNames: z.array(z.string().max(80)).max(40).optional(),
});

architectRouter.post('/api/architect/rewrite-prompt', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const parsed = rewriteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  try {
    const conn = await getOrgConnection(orgId);
    const out = await rewritePrompt(conn, parsed.data);
    logger.info({ orgId, model: parsed.data.modelId, costUsd: Number(out.costUsd.toFixed(4)) }, 'architect_prompt_rewritten');
    res.json(out);
  } catch (err) {
    logger.error({ err, orgId }, 'architect_rewrite_failed');
    res.status(400).json({ error: 'rewrite_failed', message: (err as Error).message });
  }
});

// ── ✦ Ask Archon — questions and proposed config changes ─────────────
const copilotSchema = z.object({
  message: z.string().min(1).max(8_000),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8_000) })).max(20).optional(),
  agent: z.object({
    apiName: z.string().max(120),
    name: z.string().max(120),
    department: z.string().max(60).optional(),
    nodes: z.array(z.object({
      id: z.string().max(60),
      name: z.string().max(120),
      nodeType: z.string().max(40),
      nodeSubType: z.string().max(40),
      config: z.record(z.unknown()),
    })).max(40),
  }).nullish(),
});

architectRouter.post('/api/architect/copilot', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const parsed = copilotSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  try {
    const conn = await getOrgConnection(orgId);
    const out = await copilotTurn(conn, orgId, {
      message: parsed.data.message,
      history: parsed.data.history,
      agent: parsed.data.agent ?? undefined,
    });
    res.json(out);
  } catch (err) {
    logger.error({ err, orgId }, 'architect_copilot_failed');
    res.status(400).json({ error: 'copilot_failed', message: (err as Error).message });
  }
});

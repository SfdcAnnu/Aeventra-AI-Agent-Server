/**
 * Agent Architect routes — the async build path behind "Describe what you
 * need". A build far exceeds a chat turn, so POST starts a background job
 * and the Building screen polls GET until it lands.
 *
 *   POST /api/architect/build   { requirement, attachmentText?, maxCostUsd? }
 *     → 202 { jobId }
 *   GET  /api/architect/build/:jobId
 *     → { status, steps, costUsd, result?, error? }
 *
 * The requirement is untrusted input end to end: the Analyst treats it as
 * such, no specialist holds write scope, and the only writer (the
 * compiler) writes Archon records only.
 */
import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../auth/session';
import { logger } from '../logger';
import { createBuildJob, getBuildJob } from '../architect/build-job';

export const architectRouter = Router();

const buildSchema = z.object({
  requirement: z.string().min(20, 'Describe the agent in at least a sentence or two.').max(20_000),
  attachmentText: z.string().max(200_000).nullish(),
  maxCostUsd: z.number().min(0.1).max(20).optional(),
});

architectRouter.post('/api/architect/build', sessionAuth, (req, res) => {
  const orgId = req.orgId!;
  const parsed = buildSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const job = createBuildJob(orgId, parsed.data.requirement, {
    attachmentText: parsed.data.attachmentText ?? undefined,
    maxCostUsd: parsed.data.maxCostUsd,
  });
  logger.info({ orgId, jobId: job.id, maxCostUsd: job.maxCostUsd }, 'architect_build_started');
  res.status(202).json({ jobId: job.id });
});

architectRouter.get('/api/architect/build/:jobId', sessionAuth, (req, res) => {
  const orgId = req.orgId!;
  const job = getBuildJob(req.params.jobId);
  if (!job || job.orgId !== orgId) {
    res.status(404).json({ error: 'build_not_found' });
    return;
  }
  res.json({
    jobId: job.id,
    status: job.status,
    steps: job.steps,
    costUsd: Number(job.costUsd.toFixed(4)),
    maxCostUsd: job.maxCostUsd,
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    result: job.result,
    error: job.error,
  });
});

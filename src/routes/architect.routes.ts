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
import { rewritePrompt, copilotTurn } from '../architect/assistant';
import { getOrgConnection } from '../salesforce/per-org-connection';

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

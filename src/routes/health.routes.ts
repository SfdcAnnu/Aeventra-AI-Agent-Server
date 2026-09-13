/**
 * health — liveness, and WHICH BUILD is answering.
 *
 * `uptime` alone cannot tell a fresh deploy from a spin-down wake, and on a
 * host that sleeps, those look identical. Twice during one debugging session
 * a fix was reported as live on the strength of a reset uptime while the
 * previous build was still serving traffic, which sent the investigation
 * after a phantom bug in correct code.
 *
 * So the commit is published. Render injects RENDER_GIT_COMMIT at build
 * time; anywhere else, GIT_COMMIT does the same job. It is a public commit
 * SHA of a private repo — it identifies a build, and grants nothing.
 */
import { Router } from 'express';

export const healthRouter = Router();

const COMMIT = process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? 'unknown';
const BRANCH = process.env.RENDER_GIT_BRANCH ?? process.env.GIT_BRANCH ?? 'unknown';
/** When this PROCESS started — distinct from when its code was built. */
const BOOTED_AT = new Date().toISOString();

healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    commit: COMMIT.slice(0, 12),
    branch: BRANCH,
    bootedAt: BOOTED_AT,
  });
});

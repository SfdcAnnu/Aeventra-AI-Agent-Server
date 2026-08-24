/**
 * Resumes durable runs whose wait has elapsed, and auto-rejects approvals
 * that timed out with nobody deciding. Runs on a plain `setInterval` plus
 * one sweep at boot — no external queue/cron infra, matching the rest of
 * this server's footprint.
 *
 * Free-tier reality: this only fires while the process is actually awake.
 * A run due while the server is asleep resumes on the NEXT wake (this same
 * sweep runs once at boot) rather than within POLL_INTERVAL_MS of being
 * due — degraded promptness, not degraded correctness. An always-on
 * instance is what buys the "resumes within ~15s" experience.
 */
import { RunsRepo } from '../db/runs.repo';
import { resumeRunById } from '../orchestrator/engine';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { AgentCache } from '../chat/agent-cache';
import { schedulePlatformEvent } from '../salesforce/callback';
import { logger } from '../logger';
import type { AgentRun } from '@prisma/client';

const POLL_INTERVAL_MS = 15_000;
let timer: NodeJS.Timeout | null = null;

export function startRunPoller(): void {
  if (timer) return;
  // Fire once immediately (boot catch-up sweep), then on an interval.
  sweep().catch((err) => logger.error({ err }, 'run_poller_boot_sweep_failed'));
  timer = setInterval(() => {
    sweep().catch((err) => logger.error({ err }, 'run_poller_sweep_failed'));
  }, POLL_INTERVAL_MS);
  logger.info({ intervalMs: POLL_INTERVAL_MS }, 'run_poller_started');
}

export function stopRunPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function sweep(): Promise<void> {
  const [dueWaits, overdueApprovals] = await Promise.all([
    RunsRepo.dueWaits(),
    RunsRepo.overdueApprovals(),
  ]);

  for (const run of dueWaits) {
    await resumeOne(run, undefined).catch((err) =>
      logger.error({ err, runId: run.id }, 'run_poller_resume_wait_failed'));
  }
  for (const run of overdueApprovals) {
    await autoRejectOverdue(run).catch((err) =>
      logger.error({ err, runId: run.id }, 'run_poller_timeout_reject_failed'));
  }
}

async function resumeOne(run: AgentRun, decision: 'approved' | 'rejected' | undefined): Promise<void> {
  const conn = await getOrgConnection(run.orgId);
  const agent = await AgentCache.load(run.orgId, run.agentApiName, conn);
  if (!agent) {
    logger.warn({ runId: run.id, agentApiName: run.agentApiName }, 'run_poller_agent_missing');
    return;
  }
  const result = await resumeRunById({ orgId: run.orgId, runId: run.id, agent, conn, decision });
  logger.info({ runId: run.id, agentStatus: result.agentStatus }, 'run_poller_resumed');

  // Push the post-resume status (SUCCESS/ERROR, or another pause) back to
  // AgentExecution__c — without this the Salesforce log stays stuck showing
  // WAITING forever, since the poller resumes runs entirely in-process with
  // no Apex round trip to report the outcome.
  await schedulePlatformEvent({
    orgId: run.orgId,
    agentApiName: run.agentApiName,
    recordId: run.recordId ?? '',
    result,
  }).catch((err) => logger.error({ err, runId: run.id }, 'run_poller_platform_event_failed'));
}

/**
 * Archon's own "give up waiting" safety valve — unrelated to how a real
 * decision is discovered (see routes/webhooks.routes.ts). This only stops
 * the FLOW from waiting forever; the native Approval Process instance
 * itself is left alone in Salesforce, since cancelling it isn't this
 * server's call to make.
 */
async function autoRejectOverdue(run: AgentRun): Promise<void> {
  await resumeOne(run, 'rejected');
}

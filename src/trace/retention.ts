/**
 * retention — traces expire on their own, in two stages.
 *
 * Payloads are the sensitive half: they hold customer conversation
 * content, verbatim, for every tenant. They are stripped first and early
 * (14 days by default). The metric rows — who ran what, how long it took,
 * what it cost — carry no conversation content and are useful for far
 * longer, so they live on until the second horizon (90 days).
 *
 * That split is the whole point. Without it you would choose between
 * losing your cost history and keeping everyone's conversations forever.
 *
 * Runs on the same in-process interval pattern as installs.repo's stale
 * PendingSetup sweep — no scheduler, no extra infrastructure, and a
 * restart simply picks it up again.
 */
import { prisma } from '../db/client';
import { logger } from '../logger';

const envInt = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** How long the exact request/response bodies survive. */
export const PAYLOAD_RETENTION_DAYS = envInt('TRACE_PAYLOAD_RETENTION_DAYS', 14);
/** How long the metric row survives after that. */
export const TRACE_RETENTION_DAYS = envInt('TRACE_RETENTION_DAYS', 90);

const SWEEP_INTERVAL_MS = envInt('TRACE_SWEEP_INTERVAL_MS', 6 * 60 * 60 * 1000);
/** Bounded per pass so a long-idle instance cannot open one enormous
 *  transaction the first time it wakes up. */
const BATCH = envInt('TRACE_SWEEP_BATCH', 500);

const daysAgo = (n: number): Date => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

/**
 * One pass. Safe to call at any time, including concurrently with writes.
 * Returns what it removed so the caller can log or assert on it.
 */
export async function sweepTraces(): Promise<{ payloadsPurged: number; tracesDeleted: number }> {
  const payloadCutoff = daysAgo(PAYLOAD_RETENTION_DAYS);
  const traceCutoff = daysAgo(TRACE_RETENTION_DAYS);

  // Stage 1 — drop the bodies, keep the numbers. Only traces not already
  // purged, so a stable table does no work on every pass.
  const stale = await prisma.agentTrace.findMany({
    where: { createdAt: { lt: payloadCutoff }, payloadsPurgedAt: null },
    select: { id: true },
    take: BATCH,
  });
  let payloadsPurged = 0;
  if (stale.length > 0) {
    const ids = stale.map(t => t.id);
    // The steps ARE the payloads — deleting them leaves the trace row and
    // its totals intact, which is exactly the shape we want to keep.
    await prisma.agentTraceStep.deleteMany({ where: { traceId: { in: ids } } });
    await prisma.agentTrace.updateMany({
      where: { id: { in: ids } },
      data: { payloadsPurgedAt: new Date() },
    });
    payloadsPurged = ids.length;
  }

  // Stage 2 — the metric rows finally go. Cascade takes any steps that
  // somehow outlived stage 1.
  const { count: tracesDeleted } = await prisma.agentTrace.deleteMany({
    where: { createdAt: { lt: traceCutoff } },
  });

  if (payloadsPurged > 0 || tracesDeleted > 0) {
    logger.info(
      { payloadsPurged, tracesDeleted, payloadRetentionDays: PAYLOAD_RETENTION_DAYS, traceRetentionDays: TRACE_RETENTION_DAYS },
      'trace_retention_swept',
    );
  }
  return { payloadsPurged, tracesDeleted };
}

let timer: NodeJS.Timeout | null = null;

/** Start the periodic sweep. Idempotent, and a failure never propagates —
 *  retention falling behind must not take the server down with it. */
export function startTraceRetention(): void {
  if (timer) return;
  const run = () => {
    void sweepTraces().catch(err =>
      logger.warn({ err: err instanceof Error ? err.message : err }, 'trace_retention_failed'),
    );
  };
  // A first pass shortly after boot clears anything that expired while the
  // instance was asleep; free-tier hosts spin down for hours at a time.
  timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref?.();
  setTimeout(run, 30_000).unref?.();
  logger.info(
    { everyMs: SWEEP_INTERVAL_MS, payloadRetentionDays: PAYLOAD_RETENTION_DAYS, traceRetentionDays: TRACE_RETENTION_DAYS },
    'trace_retention_started',
  );
}

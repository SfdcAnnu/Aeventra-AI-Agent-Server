/**
 * admin-traces — the internal flight recorder's read surface.
 *
 * NOT sessionAuth. Every other route is scoped to one org by the caller's
 * session key; this one reads ACROSS tenants, which is precisely what
 * makes it useful for support and precisely why no subscriber may ever
 * reach it. It is guarded by ADMIN_API_KEY, a secret only the operator
 * holds, and the whole router is absent unless that variable is set — so
 * a default deployment has no cross-tenant surface at all, and forgetting
 * to configure it fails closed rather than open.
 */
import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../db/client';
import { logger } from '../logger';
import { PAYLOAD_RETENTION_DAYS, TRACE_RETENTION_DAYS } from '../trace/retention';
import { renderConsole } from '../trace/console-html';

export const adminTracesRouter = Router();

const KEY = process.env.ADMIN_API_KEY ?? '';
export const adminTracesEnabled = KEY.length >= 16;

/** Constant-time compare so the key cannot be recovered by timing. */
function keyMatches(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('Authorization') ?? '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7).trim()
    : String(req.query.key ?? '');   // lets the console page load in a browser
  if (!supplied || !keyMatches(supplied)) {
    // 404, not 401: an unauthenticated caller learns nothing about whether
    // this endpoint exists.
    res.status(404).json({ error: 'not_found' });
    return;
  }
  next();
}

const MAX_PAGE = 200;

/** Turn query parameters into a Prisma filter. Shared by list and delete
 *  so the console can never delete something different from what it
 *  showed you. */
function whereFrom(q: Record<string, unknown>): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  const str = (k: string) => (typeof q[k] === 'string' && q[k] ? String(q[k]) : undefined);

  if (str('orgId')) where.orgId = str('orgId');
  if (str('userId')) where.userId = str('userId');
  if (str('agentApiName')) where.agentApiName = str('agentApiName');
  if (str('agentId')) where.agentId = str('agentId');
  if (str('sessionId')) where.sessionId = str('sessionId');
  if (str('channel')) where.channel = str('channel');
  if (str('status')) where.status = str('status');

  const from = str('from') ? new Date(String(str('from'))) : undefined;
  const to = str('to') ? new Date(String(str('to'))) : undefined;
  const range: Record<string, Date> = {};
  if (from && !Number.isNaN(from.getTime())) range.gte = from;
  if (to && !Number.isNaN(to.getTime())) range.lte = to;
  if (Object.keys(range).length > 0) where.createdAt = range;

  return where;
}

// ── list ─────────────────────────────────────────────────────────────
adminTracesRouter.get('/api/admin/traces', adminAuth, async (req, res) => {
  const where = whereFrom(req.query as Record<string, unknown>);
  const take = Math.min(Number(req.query.limit) || 50, MAX_PAGE);
  const skip = Math.max(Number(req.query.offset) || 0, 0);

  const [rows, total, agg] = await Promise.all([
    prisma.agentTrace.findMany({
      where, orderBy: { createdAt: 'desc' }, take, skip,
      select: {
        id: true, createdAt: true, orgId: true, userId: true, agentApiName: true,
        agentName: true, sessionId: true, recordId: true, channel: true, status: true,
        errorCode: true, errorMessage: true, modelCalls: true, toolCalls: true,
        tokensIn: true, tokensOut: true, cachedTokens: true, latencyMs: true,
        usageByModel: true, payloadsPurgedAt: true,
      },
    }),
    prisma.agentTrace.count({ where }),
    prisma.agentTrace.aggregate({
      where,
      _sum: { tokensIn: true, tokensOut: true, cachedTokens: true, modelCalls: true },
      _avg: { latencyMs: true },
    }),
  ]);
  const errors = await prisma.agentTrace.count({ where: { ...where, status: 'error' } });

  res.json({
    traces: rows, total, errors,
    totals: {
      tokensIn: agg._sum.tokensIn ?? 0,
      tokensOut: agg._sum.tokensOut ?? 0,
      cachedTokens: agg._sum.cachedTokens ?? 0,
      modelCalls: agg._sum.modelCalls ?? 0,
      avgLatencyMs: Math.round(agg._avg.latencyMs ?? 0),
    },
    retention: { payloadDays: PAYLOAD_RETENTION_DAYS, traceDays: TRACE_RETENTION_DAYS },
  });
});

// ── one trace, with every step and its payloads ──────────────────────
adminTracesRouter.get('/api/admin/traces/:id', adminAuth, async (req, res) => {
  const trace = await prisma.agentTrace.findUnique({
    where: { id: String(req.params.id) },
    include: { steps: { orderBy: { seq: 'asc' } } },
  });
  if (!trace) { res.status(404).json({ error: 'not_found' }); return; }
  res.json({ trace });
});

// ── filter-scoped purge ──────────────────────────────────────────────
adminTracesRouter.delete('/api/admin/traces', adminAuth, async (req, res) => {
  const q = { ...(req.query as Record<string, unknown>), ...(req.body ?? {}) };
  const where = whereFrom(q);

  // A delete must NAME its scope. Without this, one mistyped or truncated
  // request wipes every tenant's history — so an unscoped delete is
  // refused outright rather than interpreted generously.
  const range = where.createdAt as { gte?: Date; lte?: Date } | undefined;
  if (!where.orgId || !range?.gte) {
    res.status(400).json({
      error: 'scope_required',
      message: 'A delete must name an orgId and a "from" date. Refusing to delete everything.',
    });
    return;
  }

  const matched = await prisma.agentTrace.count({ where });
  if (q.dryRun === true || q.dryRun === 'true') {
    res.json({ dryRun: true, matched });
    return;
  }
  const { count } = await prisma.agentTrace.deleteMany({ where });
  logger.warn({ where, deleted: count }, 'admin_traces_purged');
  res.json({ deleted: count, matched });
});

// ── the console itself ───────────────────────────────────────────────
adminTracesRouter.get('/admin/traces', adminAuth, (_req, res) => {
  res.type('html').send(renderConsole());
});

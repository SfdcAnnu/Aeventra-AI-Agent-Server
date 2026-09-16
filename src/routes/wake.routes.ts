/**
 * POST /api/connectors/wake — one shallow probe of every MCP server this
 * org depends on, so an admin can cold-start the whole chain BEFORE an
 * agent run instead of letting the first tool call eat the wake-up.
 *
 * Why it is shallow (one GET per target, ~12s cap, no retry loop): the
 * caller is the Setup page polling every few seconds through Apex, and
 * Apex callouts have their own ceiling. Each probe is enough to make the
 * host spin the service up; the poll loop on the browser side reports
 * progress ("waking…" → "online") without any request ever hanging long.
 *
 * Reaching this route at all proves the Archon server itself is awake, so
 * the response also carries this build's identity (same fields as /health).
 *
 *   body:    { targets: [{ key, name, url }] }   url = https origin, no path
 *   returns: { server: { commit, bootedAt, uptime },
 *              targets: [{ key, name, url, status, ms, httpStatus?, message? }] }
 *   status:  'online'      — answered 2xx-4xx (a 401/404 still means "awake")
 *            'waking'      — 5xx from the host's edge, or no answer in time
 *            'unreachable' — DNS/TLS/connection failure
 */
import { Router } from 'express';
import { z } from 'zod';
import { logger } from '../logger';
import { sessionAuth } from '../auth/session';

export const wakeRouter = Router();

const COMMIT = process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? 'unknown';
const BOOTED_AT = new Date().toISOString();

/** Per-target cap. Below Apex's timeout with room for the JSON round trip. */
export const PROBE_TIMEOUT_MS = 12_000;
const MAX_TARGETS = 25;

const ORIGIN_RE = /^https:\/\/[a-zA-Z0-9.-]+(:\d+)?$/;
const LOCALHOST_RE = /^http:\/\/localhost(:\d+)?$/;

const bodySchema = z.object({
  targets: z
    .array(
      z.object({
        key: z.string().min(1).max(200),
        name: z.string().min(1).max(200),
        url: z.string().min(1).max(500),
      })
    )
    .max(MAX_TARGETS),
});

export type ProbeStatus = 'online' | 'waking' | 'unreachable';

export interface ProbeResult {
  key: string;
  name: string;
  url: string;
  status: ProbeStatus;
  ms: number;
  httpStatus?: number;
  message?: string;
}

/** Whether a connection-level failure is "not up yet" (retry) or "not there" (stop). */
function isTransportWaking(message: string): boolean {
  // Undici phrases: aborted (our timer), socket hang up / ECONNRESET
  // (edge dropped us mid-spin-up), and 'fetch failed' wrapping ETIMEDOUT.
  return /abort|timeout|ETIMEDOUT|ECONNRESET|socket hang up|EAI_AGAIN/i.test(message);
}

export async function probe(
  target: { key: string; name: string; url: string },
  fetchImpl: typeof fetch = fetch,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<ProbeResult> {
  const url = target.url.trim().replace(/\/+$/, '');
  const started = Date.now();
  if (!ORIGIN_RE.test(url) && !LOCALHOST_RE.test(url)) {
    return { ...target, url, status: 'unreachable', ms: 0, message: 'URL must be an https origin (no path).' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // GET / — every MCP server in the catalog answers its root with a small
    // JSON identity, and even one that 404s there has demonstrably booted.
    const r = await fetchImpl(`${url}/`, { signal: controller.signal, redirect: 'manual' });
    const ms = Date.now() - started;
    if (r.status >= 500) {
      return { ...target, url, status: 'waking', ms, httpStatus: r.status, message: `Host answered ${r.status} — still starting.` };
    }
    // Render's edge answers 404 with this header when NO service is
    // deployed at the hostname (suspended, deleted, renamed). Nothing is
    // booting behind it, so "online" would be a lie.
    if (r.status === 404 && r.headers.get('x-render-routing') === 'no-server') {
      return { ...target, url, status: 'unreachable', ms, httpStatus: r.status, message: 'No service is deployed at this address on Render.' };
    }
    return { ...target, url, status: 'online', ms, httpStatus: r.status };
  } catch (err) {
    const ms = Date.now() - started;
    const message = (err as Error)?.message ?? String(err);
    const cause = ((err as Error & { cause?: Error })?.cause?.message ?? '') as string;
    const text = `${message} ${cause}`.trim();
    if (isTransportWaking(text)) {
      return { ...target, url, status: 'waking', ms, message: `No answer within ${Math.round(timeoutMs / 1000)}s — still starting.` };
    }
    return { ...target, url, status: 'unreachable', ms, message: text.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

wakeRouter.post('/api/connectors/wake', sessionAuth, async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  // De-duplicate by origin: several catalog entries can share one host, and
  // one probe per host is all the wake-up needs.
  const seen = new Set<string>();
  const unique = parsed.data.targets.filter(t => {
    const origin = t.url.trim().replace(/\/+$/, '');
    if (seen.has(origin)) return false;
    seen.add(origin);
    return true;
  });
  const targets = await Promise.all(unique.map(t => probe(t)));
  const summary = targets.reduce<Record<ProbeStatus, number>>(
    (acc, t) => ({ ...acc, [t.status]: acc[t.status] + 1 }),
    { online: 0, waking: 0, unreachable: 0 }
  );
  logger.info({ orgId: req.orgId, ...summary }, 'wake_probe');
  res.json({
    server: { commit: COMMIT.slice(0, 12), bootedAt: BOOTED_AT, uptime: process.uptime() },
    targets,
  });
});

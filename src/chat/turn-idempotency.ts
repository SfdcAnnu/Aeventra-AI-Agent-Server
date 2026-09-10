/**
 * Phase 7 — turn idempotency. Channel webhooks retry (WhatsApp double-fires
 * were live-observed) and Apex callouts can time out AFTER the server
 * started working, producing a retry of the exact same turn: same session,
 * same message, same history length. Without this, every retry is a full
 * second model turn — double tokens, and sometimes a double customer reply.
 *
 * The key is content-derived (org + session + history length + message +
 * attachment ids), so a customer legitimately sending the same text twice
 * in a row still runs: the first reply grew the history, which changes the
 * key. Only a byte-identical replay of a turn already seen dedupes.
 *
 * In-flight requests share ONE promise (a retry arriving mid-run attaches
 * to the running turn); settled results replay from RAM for a short TTL.
 * Failures are never cached — a retry after an error gets a real attempt.
 * Single-instance host, so an in-process Map is the right size of solution
 * (same stance as lc/mcp-tools' tool cache).
 */
import { logger } from '../logger';
import { fnv1a } from '../util/hash';
import type { ChatTurnRequest, ChatTurnResult } from './adapters/types';

const TTL_MS = (() => {
  const n = Number(process.env.TURN_IDEMPOTENCY_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
})();

interface Entry {
  promise: Promise<ChatTurnResult>;
  settled: boolean;
  expiresAt: number; // only enforced once settled — in-flight never expires
}

const entries = new Map<string, Entry>();

function turnKey(req: ChatTurnRequest): string {
  const attachmentIds = (req.attachments ?? []).map(a => a.contentDocumentId).join(',');
  return [
    req.context.orgId,
    req.agent.apiName,
    req.sessionId,
    req.history.length,
    req.debugMode ? 1 : 0,
    fnv1a(req.newUserMessage),
    fnv1a(attachmentIds),
  ].join('|');
}

export function withTurnIdempotency(
  fn: (req: ChatTurnRequest) => Promise<ChatTurnResult>,
): (req: ChatTurnRequest) => Promise<ChatTurnResult> {
  return (req: ChatTurnRequest) => {
    // Opportunistic sweep — the map stays a handful of recent turns.
    const now = Date.now();
    for (const [k, e] of entries) {
      if (e.settled && e.expiresAt <= now) entries.delete(k);
    }

    const key = turnKey(req);
    const hit = entries.get(key);
    if (hit) {
      logger.warn(
        { orgId: req.context.orgId, sessionId: req.sessionId, mode: hit.settled ? 'replay' : 'in_flight' },
        'lc_turn_deduplicated',
      );
      return hit.promise;
    }

    const entry: Entry = { promise: undefined as never, settled: false, expiresAt: 0 };
    entry.promise = fn(req).then(
      result => {
        entry.settled = true;
        entry.expiresAt = Date.now() + TTL_MS;
        return result;
      },
      err => {
        entries.delete(key); // never cache failures
        throw err;
      },
    );
    entries.set(key, entry);
    return entry.promise;
  };
}

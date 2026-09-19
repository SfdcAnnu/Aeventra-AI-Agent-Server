/**
 * specialist-scratch — what a specialist found before it was stopped, kept
 * for the conversation so the next call to that specialist continues from
 * it instead of starting blank.
 *
 * Specialists run isolated: each call sees only its one-line task. That is
 * the right default (cheapest, no context bleed), but it means a specialist
 * stopped by the turn budget would, when asked again, read the same org
 * metadata again and die the same way — live-seen on a flow build. This
 * keeps its last tool results per session and specialist for a short while
 * and hands them back as part of the next task. A finished call clears it.
 *
 * In-process and bounded, like the tool-result cache; a restart forgets.
 */
const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 300;
const store = new Map<string, { report: string; at: number }>();

const keyOf = (sessionId: string | null | undefined, nodeId: string) => `${sessionId ?? '-'}|${nodeId}`;

export function rememberScratch(sessionId: string | null | undefined, nodeId: string, report: string): void {
  if (!sessionId) return;
  if (store.size >= MAX_ENTRIES) {
    const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) store.delete(oldest[0]);
  }
  store.set(keyOf(sessionId, nodeId), { report, at: Date.now() });
}

export function recallScratch(sessionId: string | null | undefined, nodeId: string): string | null {
  if (!sessionId) return null;
  const hit = store.get(keyOf(sessionId, nodeId));
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) { store.delete(keyOf(sessionId, nodeId)); return null; }
  return hit.report;
}

export function clearScratch(sessionId: string | null | undefined, nodeId: string): void {
  if (sessionId) store.delete(keyOf(sessionId, nodeId));
}

/** The task as the specialist should read it when it has been here before. */
export function withScratch(task: string, prior: string | null): string {
  if (!prior) return task;
  return `${task}\n\nYOUR PREVIOUS ATTEMPT IN THIS CONVERSATION was stopped by the turn budget after the tool results below. Continue from them: do not repeat these reads, fix what they show, and finish with your report.\n${prior}`;
}

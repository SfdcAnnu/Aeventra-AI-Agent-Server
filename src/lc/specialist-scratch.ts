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

/**
 * WHAT THE CONVERSATION ALREADY ESTABLISHED.
 *
 * A finished specialist call clears its scratch, and the next call — next
 * turn, or another specialist this turn — saw only its brief. A Metadata
 * Expert conversation that had just created an object and its fields then
 * asked for a layout, and the specialist described that object field by
 * field again: 101 tool calls and a token-budget stop, for facts the chat
 * already held. The earlier specialist results and deploy results are in
 * the conversation as tool messages; this hands the newest of them to the
 * specialist with its brief. Taken from the saved history, so a restart
 * does not forget them.
 */
const FINDING_CHARS = 2500;
const FINDINGS_CHARS = 9000;

/** Tool results worth carrying: the named specialist calls, and what a
 *  deploy or activation reported. */
export function collectFindings(
  messages: Array<{ name?: string; content?: unknown; _getType?: () => string }>,
  specialistTools: Set<string>,
): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m?._getType?.() !== 'tool' || !m.name) continue;
    if (!specialistTools.has(m.name) && !/^(deploy|get_deploy_status|activate_flow|rollback)$/.test(m.name)) continue;
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    if (!text.trim() || /^Specialist failed|^Budget exhausted|^Parallel specialist limit/.test(text)) continue;
    out.push(`${m.name}: ${text.length > FINDING_CHARS ? `${text.slice(0, FINDING_CHARS)} …(cut)` : text}`);
  }
  return out;
}

/** The brief with what is already known, newest last, under one cap. */
export function withFindings(task: string, findings: string[]): string {
  if (findings.length === 0) return task;
  const kept: string[] = [];
  let size = 0;
  for (let i = findings.length - 1; i >= 0; i--) {
    if (size + findings[i].length > FINDINGS_CHARS && kept.length > 0) break;
    kept.unshift(findings[i]);
    size += findings[i].length;
  }
  return `${task}\n\nALREADY ESTABLISHED IN THIS CONVERSATION (earlier specialist results and deploys, newest last). ` +
    'What these name exists as they describe — use those API names, fields and values as given. Do not describe, list or retrieve ' +
    `them again to confirm; read the org only for what is not here, or retrieve one you are about to modify.\n${kept.join('\n')}`;
}

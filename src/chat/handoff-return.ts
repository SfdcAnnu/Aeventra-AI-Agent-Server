/**
 * handoff-return — a conversation that went to a person and came back, as
 * the model reads it.
 *
 * ChatSessionHandoffHandler (Apex) writes two System rows: "Handed off to
 * Rahul Mehta · reason: …" when the agent hands over, and "Returned to the
 * agent by Rahul Mehta · pricing clarified" when it comes back. System rows
 * are otherwise screen chrome the model never sees; these two it must see,
 * or it greets the customer as if nothing happened and re-opens what the
 * person settled. A colleague's own replies are in the history too, marked
 * on the assistant's side by AgentChatController.
 */
const HANDOFF_LINE = /^Handed off to .+/s;
const RETURN_LINE = /^Returned to the agent\b/s;

export const HANDOFF_LABEL = '[HANDED OFF]';
export const BACK_LABEL = '[BACK FROM A PERSON]';

export function isHandoffLine(content: string | null | undefined): boolean {
  if (!content) return false;
  const t = content.trim();
  return HANDOFF_LINE.test(t) || RETURN_LINE.test(t);
}

/** The row as the model reads it. */
export function handoffLineMessage(content: string): string {
  const line = content.trim();
  if (RETURN_LINE.test(line)) {
    return `${BACK_LABEL} ${line}\n` +
      'A colleague handled this conversation in between; their replies are in the history, marked. ' +
      'Carry on from where they left it: do not repeat what they settled, do not greet the customer as if new, and use the note above if there is one.';
  }
  return `${HANDOFF_LABEL} ${line}\nFrom here until the return line, a person was answering, not you.`;
}

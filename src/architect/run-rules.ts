/**
 * RULES EVERY AUTOMATION AGENT RUNS BY — added by the compiler, not left
 * to the instructions writer.
 *
 * Measured on a Flow-started handoff agent (28 Sep 2026): its first run
 * was right on every record, but
 *   - a re-run read the Opportunity's Description, saw its own earlier
 *     summary, and declared the work done without one query — so a
 *     welcome-call Task someone had deleted was never recreated, and the
 *     summary went on claiming it existed;
 *   - its Chatter post said "1 welcome calls booked" after booking 2,
 *     because the number was fixed before the second Task was written;
 *   - summary lines used its own phrasing ("No renewal Opportunity
 *     needed") where the requirement gave the words ("not a new customer").
 * None of that is specific to the agent: any unattended agent that writes
 * records, runs more than once, and reports what it did can fail the same
 * way. So the rules travel with every automation agent the builder saves.
 */
export const RUN_RULES_MARKER = 'AUTOMATION RUN RULES';

export const AUTOMATION_RUN_RULES =
  `${RUN_RULES_MARKER} (the platform adds these to every automation agent; they override anything above that disagrees):\n` +
  '1. CHECK THE LIVE DATA ON EVERY RUN. Before you decide that a step is done or not needed, query the records it would create or change. ' +
  'Never treat a Description, a summary, a note, a Chatter post or anything an earlier run wrote as proof that work was done — records ' +
  'may have been deleted or changed since. A re-run makes every check again and creates only what is actually missing.\n' +
  '2. COUNT AFTER YOU WRITE. Every number you report — in a post, a message, a field or a summary — is counted from the records as they ' +
  'stand after this run\'s writes (query them again if you need to), never from what you planned to write.\n' +
  '3. USE THE REQUIREMENT\'S WORDS. Where these instructions give the words for an outcome (for example "already open", "not a new ' +
  'customer", "no assets"), write exactly those words, not your own phrasing.\n' +
  '4. WRITE THE SUMMARY LAST, from what the records show after every other step, so it never claims something the org does not have.';

/** The root agent's instructions with the run rules added once. */
export function withRunRules(instructions: string): string {
  if (instructions.includes(RUN_RULES_MARKER)) return instructions;
  return `${instructions.trimEnd()}\n\n${AUTOMATION_RUN_RULES}`;
}

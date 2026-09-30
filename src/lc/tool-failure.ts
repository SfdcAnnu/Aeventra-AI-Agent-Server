/**
 * What counts as a failed tool call, which failures are worth one retry,
 * and what an agent is told when its tools are missing. One place, so the
 * transcript flag, the write guard, specialist results and the approval
 * executor can never disagree.
 *
 * WHY TEXT AND NOT JUST STATUS. LangGraph's ToolNode catches a throwing
 * tool and answers the model with "Error: <message>\n Please fix your
 * mistakes." -- without status 'error'. Every MCP failure (INVALID_FIELD,
 * a dropped connection) therefore reached the transcript as isError:false,
 * and the write guard counted a FAILED create as a write. Live, a sales
 * agent told a customer a real product did not exist because its price
 * query had failed. Built-in actions answer "Create failed: ..." and
 * specialists "Specialist failed: ..." the same way.
 */

const FAILURE_PREFIX_RE = /^\s*(Error\b|Create failed\b|Update failed\b|Specialist failed\b|HELPER ERROR\b)/;

/** True when a tool's result says it did not do its job. */
export function isToolFailure(output: unknown, status?: string): boolean {
  if (status === 'error') return true;
  return typeof output === 'string' && FAILURE_PREFIX_RE.test(output);
}

/** A failure of the wire, not of the request: the same call may well
 *  succeed a second later. Validation errors (INVALID_FIELD, REQUIRED_...)
 *  are deliberately absent -- retrying them only repeats the mistake. */
const TRANSIENT_RE = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|fetch failed|FetchError|network timeout|UND_ERR_|other side closed/i;

export function isTransientNetworkError(message: string): boolean {
  return TRANSIENT_RE.test(message);
}

/** A reset can arrive AFTER Salesforce committed the write. Repeating an
 *  update by Id lands on the same record; repeating a create makes a
 *  second one. So a create is retried only when the connection never
 *  opened (refused / DNS), and anything else transient is retried freely. */
const CREATE_TOOL_RE = /create|insert|upsert/i;
const NEVER_SENT_RE = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i;

export function isSafeToRetry(toolName: string, message: string): boolean {
  if (!isTransientNetworkError(message)) return false;
  return !CREATE_TOOL_RE.test(toolName) || NEVER_SENT_RE.test(message);
}

export const TRANSIENT_RETRY_WAIT_MS = 1_500;

/**
 * The notice an agent -- root or specialist -- gets when a connector's
 * tools could not be loaded this turn.
 *
 * Saying "I can't reach it" was already asked for. What went wrong live
 * was everything after it: with Salesforce asleep, agents told customers
 * "I'll make sure your issue is logged with high priority" and "please
 * hold while I retrieve this" -- promises nothing would ever keep, because
 * nothing runs until the person writes again.
 */
export function toolsUnavailableNotice(unavailable: string[]): string | null {
  if (unavailable.length === 0) return null;
  return `TOOLS UNAVAILABLE RIGHT NOW: ${unavailable.join(', ')}. Any tool from these is not callable this turn. ` +
    'If the person asks for something that needs one, say plainly, in one or two sentences, that you cannot reach ' +
    'it at the moment and ask them to try again shortly. Do NOT promise to do it later, do NOT say it will be ' +
    'logged, saved, scheduled or followed up, and do NOT ask them to hold on or wait -- nothing happens until they ' +
    'write again. Do NOT answer from memory, guess, or substitute a different tool or specialist for the one you ' +
    'are missing.';
}

/** What a specialist's caller is told when that specialist's own tools
 *  failed: its prose may read like an answer ("no such product") when it
 *  is really an error. */
export function specialistFailureNote(failures: Array<{ name: string; output?: unknown }>): string | null {
  if (failures.length === 0) return null;
  const first = failures[0];
  const detail = String(first.output ?? '').replace(/\s+/g, ' ').slice(0, 240);
  return `\n\nHELPER ERROR (for you, not the person): ${failures.length} of this specialist's tool call(s) FAILED ` +
    `(${first.name}: ${detail}). Its answer above is unverified -- a failed lookup is not "not found". ` +
    'Do not tell the person that something does not exist or is not available because of it; say you could not ' +
    'check it right now.';
}

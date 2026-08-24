import { register } from './registry';
import type { NodeExecutor } from './registry';
import type { ExecutionContext } from '../orchestrator/context';

/**
 * If/else node — evaluates `config.condition` against current context state.
 * Returns `nextPort: 'yes' | 'no'` so the engine can branch.
 *
 * Supported condition shapes (intentionally simple — engine evaluates, not Claude):
 *   "{!ai.score} > 80"
 *   "{!record.Status} == 'New'"
 *   "{!ai.priority} != 'Cold'"
 */
const ifElseExec: NodeExecutor = async (node, ctx) => {
  const raw = String(node.config.condition ?? '').trim();
  const unresolved = findUnresolvedTokens(raw, ctx);
  const condition = ctx.interpolate(raw);
  const result = evalCondition(condition);

  const output: Record<string, unknown> = { condition, result };
  if (unresolved.length > 0) {
    // Common failure mode: {!ai.score} referenced before the AI node's reply
    // actually ended with a parseable score/priority tail (best-effort text
    // parsing — see parseScoreTail in chat/headless.ts) — the condition then
    // silently evaluates against an empty string instead of erroring, which
    // looks indistinguishable from "if/else is broken" in Execution Logs.
    // Surfacing it here means the real cause shows up without guessing.
    output.warning = `${unresolved.join(', ')} resolved to nothing — condition evaluated against an empty value.`;
  }

  return {
    nodeId: node.id,
    nodeSubType: 'if_else',
    success: true,
    output,
    nextPort: result ? 'yes' : 'no',
  };
};

/** Which `{!...}` tokens in the raw condition resolve to null/undefined. */
function findUnresolvedTokens(raw: string, ctx: ExecutionContext): string[] {
  const tokens = raw.match(/\{!([^}]+)\}/g) ?? [];
  const missing: string[] = [];
  for (const t of tokens) {
    const path = t.slice(2, -1).trim();
    if (ctx.resolve(path) == null) missing.push(t);
  }
  return missing;
}

register('if_else', ifElseExec);

/**
 * Set Variable — Flow-style Assignment. Interpolates `config.template` and
 * stores it under the user-chosen `config.variableName`, which the engine
 * registers as an EXTRA alias (see ExecutionContext.recordResult) so
 * downstream nodes reference it the same way they reference {!ai.score}:
 * `{!myVariableName.value}`.
 */
const setVariableExec: NodeExecutor = async (node, ctx) => {
  const varName = String(node.config.variableName ?? '').trim();
  const value = ctx.interpolate(String(node.config.template ?? ''));
  return {
    nodeId: node.id,
    nodeSubType: 'set_variable',
    success: true,
    output: { value },
    customAlias: varName || undefined,
  };
};

register('set_variable', setVariableExec);

const MS_PER_UNIT: Record<string, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};
/** Delays this short or shorter just sleep inline — no persistence overhead for a <=1min wait. */
const INLINE_WAIT_CEILING_MS = 60_000;

/**
 * Wait — durable delay. Short waits (<=60s) sleep inline exactly like
 * before; anything longer signals `pause` and the engine persists the run
 * and stops instead of blocking a request thread for hours/days. The
 * poller (server/src/scheduler/run-poller.ts) resumes it once due.
 */
const waitExec: NodeExecutor = async (node) => {
  const config = node.config as { delayValue?: number; delayUnit?: string };
  const value = Math.max(0, Number(config.delayValue) || 0);
  const unit = MS_PER_UNIT[config.delayUnit ?? 'minutes'] ? config.delayUnit! : 'minutes';
  const ms = value * MS_PER_UNIT[unit];

  if (ms <= INLINE_WAIT_CEILING_MS) {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    return { nodeId: node.id, nodeSubType: 'wait', success: true, output: { delayedMs: ms, mode: 'inline' } };
  }

  const resumeAt = new Date(Date.now() + ms).toISOString();
  return {
    nodeId: node.id,
    nodeSubType: 'wait',
    success: true,
    output: { resumeAt, mode: 'durable' },
    pause: { kind: 'wait', resumeAt },
  };
};

register('wait', waitExec);

/**
 * Loop — the real per-iteration engine work lives in orchestrator/engine.ts
 * (runLoopNode): it needs the graph + nested BFS a plain NodeExecutor
 * doesn't have access to, so the engine special-cases `nodeSubType==='loop'`
 * BEFORE reaching the registry. This registration only exists so a stray
 * lookup (e.g. echoExecutor fallback logic) never silently no-ops one.
 */
register('loop', async (node) => ({
  nodeId: node.id,
  nodeSubType: 'loop',
  success: false,
  error: 'Loop nodes are handled by the engine directly and should never reach this executor — this indicates a bug.',
}));

/**
 * Approval — submits the trigger record into a REAL Salesforce Approval
 * Process (native REST "Process Approval Requests" resource), then pauses.
 * Salesforce's own tooling handles routing/notification/decision entirely
 * (email, mobile, Chatter, Home page "Items to Approve") — no custom
 * approver-resolution or approval object of our own.
 *
 * Archon deliberately stops at Submit — it ships no decision-detection
 * mechanism of its own (no webhook, no polling). Resuming the paused run
 * is the customer's own call: their own automation (built however they
 * like, reacting to their own Approval Process's outcome however they've
 * configured it) can hit the existing generic resume endpoint,
 * POST /api/agent/runs/resume, with { recordId, decision } — no
 * Archon-specific setup required on their end beyond that one call. If
 * nothing ever calls it, timeoutHours below is the only guaranteed way the
 * run stops waiting (auto-rejects — see scheduler/run-poller.ts).
 */
interface ApprovalSubmitResult {
  instanceId?: string;
  instanceStatus?: string;
  success?: boolean;
  errors?: Array<{ message?: string }> | null;
}

const approvalExec: NodeExecutor = async (node, ctx) => {
  const config = node.config as { processDefinitionId?: string; comments?: string; timeoutHours?: number };
  const timeoutHours = Number(config.timeoutHours) || 0;
  const comments = config.comments ? ctx.interpolate(config.comments) : undefined;

  if (!ctx.recordId) {
    return { nodeId: node.id, nodeSubType: 'approval', success: false, error: 'Approval node requires a trigger record — no recordId on this run.' };
  }

  const request: Record<string, unknown> = { actionType: 'Submit', contextId: ctx.recordId };
  if (config.processDefinitionId) request.processDefinitionNameOrId = config.processDefinitionId;
  if (comments) request.comments = comments;

  try {
    const res = await ctx.conn.request<ApprovalSubmitResult[]>({
      method: 'POST',
      url: `/services/data/v${ctx.conn.version}/process/approvals/`,
      body: JSON.stringify({ requests: [request] }),
      headers: { 'Content-Type': 'application/json' },
    });
    const result = res?.[0];
    if (!result?.success || !result.instanceId) {
      const message = result?.errors?.[0]?.message || 'Submission did not return a process instance.';
      return { nodeId: node.id, nodeSubType: 'approval', success: false, error: message };
    }

    const timeoutAt = timeoutHours > 0 ? new Date(Date.now() + timeoutHours * 3_600_000) : null;
    return {
      nodeId: node.id,
      nodeSubType: 'approval',
      success: true,
      output: { instanceId: result.instanceId, status: result.instanceStatus ?? 'Pending' },
      pause: { kind: 'approval', approvalToken: result.instanceId, timeoutAt: timeoutAt?.toISOString() },
    };
  } catch (err) {
    return { nodeId: node.id, nodeSubType: 'approval', success: false, error: (err as Error).message };
  }
};

register('approval', approvalExec);

function evalCondition(expr: string): boolean {
  // Very narrow evaluator — supports `<lhs> <op> <rhs>` only.
  // We intentionally avoid `eval()` / `Function()` for security.
  const match = expr.match(/^\s*(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$/);
  if (!match) return Boolean(expr);
  const [, lhs, op, rhs] = match;
  const a = coerce(stripQuotes(lhs));
  const b = coerce(stripQuotes(rhs));
  switch (op) {
    case '==': return a === b;
    case '!=': return a !== b;
    case '>':  return Number(a) > Number(b);
    case '<':  return Number(a) < Number(b);
    case '>=': return Number(a) >= Number(b);
    case '<=': return Number(a) <= Number(b);
    default:   return false;
  }
}

function stripQuotes(s: string): string {
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  return s;
}

function coerce(s: string): string | number | boolean {
  if (s === 'true') return true;
  if (s === 'false') return false;
  const n = Number(s);
  return Number.isFinite(n) && s.trim() !== '' ? n : s;
}

/**
 * Phase 7 — the approval gate for chat-mode tools. Wraps any tool whose
 * tool NODE is marked requiresApproval: instead of executing, the call is
 * suspended as a durable ChatApproval row and the model gets a tool result
 * telling it (and through it, the user) that the action awaits approval.
 * Fail-closed by construction: no path through this wrapper ever reaches
 * the real tool — approved actions execute later via
 * chat/approval-executor.ts.
 */
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { logger } from '../logger';
import { ChatApprovalsRepo } from '../db/chat-approvals.repo';
import type { AgentAction } from '../types';
import type { ChatApproval } from '@prisma/client';

export interface ApprovalMeta {
  orgId: string;
  agentApiName: string;
  planVersion?: string | null;
  sessionId: string;
  userId: string;
  recordContextId?: string | null;
  recordContextType?: string | null;
}

/** Tool names that must suspend, from the resolved tool-node actions.
 *  Apex/Flow custom tools are published by the MCP server under prefixed
 *  names, so both the raw and prefixed forms are included — the set only
 *  ever matches names that actually loaded. 'Prebuilt' nodes are gated
 *  inside buildPrebuiltTools (their runtime name is a generated slug). */
export function approvalRequiredNames(actions: AgentAction[]): Set<string> {
  const names = new Set<string>();
  for (const a of actions) {
    if (a.requiresApproval !== true || a.isEnabled === false) continue;
    if (a.actionType === 'Prebuilt') continue;
    names.add(a.toolName);
    names.add(`apex__${a.toolName}`);
    names.add(`flow__${a.toolName}`);
  }
  return names;
}

const suspendedMessage = (id: string): string =>
  `PENDING_APPROVAL: this action requires human approval and was NOT executed. Approval request ${id} was created ` +
  'for the team. Tell the user the action is awaiting approval and will be completed once approved — do NOT say or ' +
  'imply it is already done.';

/** How long a rejection keeps the same call from being re-submitted. */
const REJECTION_HOLD_MS = 30 * 60 * 1000;

const when = (d: Date | null | undefined): string => (d ? d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'earlier');

/**
 * THE SAME CALL IS ONE REQUEST, NOT ONE PER TURN.
 *
 * Every gated call used to open a new approval row. A person approved a
 * deploy, it ran, and the agent — told "it's approved, check" — called
 * deploy again and opened another request, nine turns running. The
 * newest request for exactly this call answers instead: pending says so,
 * executed hands back the result, rejected holds for a while. Null means
 * a fresh request is right (nothing prior, failed, expired, or an old
 * rejection).
 */
function priorVerdict(prior: ChatApproval): string | null {
  const by = prior.decidedBy ? ' by a person' : '';
  switch (prior.status) {
    case 'Pending':
    case 'Approved':
      return `PENDING_APPROVAL: this exact action is already awaiting approval as request ${prior.id} (created ${when(prior.createdAt)}). ` +
        'No new request was created and nothing ran. Tell the user it is still waiting for their approval; when they approve it, ' +
        'its outcome appears in this conversation as an approval outcome — do not call this tool again for it.';
    case 'Executed':
      return `ALREADY_EXECUTED: this exact action was approved${by} and ran at ${when(prior.decidedAt)}; it was NOT run again. ` +
        `Its result: ${(prior.resultText ?? '(no output)').slice(0, 4000)}`;
    case 'Rejected':
      if (prior.decidedAt && Date.now() - prior.decidedAt.getTime() < REJECTION_HOLD_MS) {
        return `REJECTED: a person rejected this exact action at ${when(prior.decidedAt)}. It was not submitted again — ` +
          'ask what they want changed instead of resubmitting it.';
      }
      return null;
    default:
      return null;
  }
}

export function approvalGate(meta: ApprovalMeta): (t: StructuredToolInterface) => StructuredToolInterface {
  return (t: StructuredToolInterface) =>
    tool(
      async (args: unknown) => {
        try {
          const prior = await ChatApprovalsRepo.findLatestForCall(meta.orgId, meta.sessionId, t.name, args).catch(() => null);
          const verdict = prior ? priorVerdict(prior) : null;
          if (verdict) {
            logger.info(
              { orgId: meta.orgId, sessionId: meta.sessionId, tool: t.name, approvalId: prior!.id, status: prior!.status },
              'lc_chat_approval_repeated_call',
            );
            return verdict;
          }
          const row = await ChatApprovalsRepo.create({ ...meta, toolName: t.name, argsJson: args });
          logger.info(
            { orgId: meta.orgId, agentApiName: meta.agentApiName, sessionId: meta.sessionId, tool: t.name, approvalId: row.id },
            'lc_chat_approval_suspended',
          );
          return suspendedMessage(row.id);
        } catch (err) {
          logger.error(
            { orgId: meta.orgId, tool: t.name, err: err instanceof Error ? err.message : String(err) },
            'lc_chat_approval_create_failed',
          );
          // Still fail-closed: the action does not run, and the model is
          // told not to claim it did.
          return 'PENDING_APPROVAL: this action requires human approval and was NOT executed, and the approval ' +
            'request could not be recorded just now. Tell the user the team will follow up on this action — do ' +
            'NOT say or imply it was done.';
        }
      },
      { name: t.name, description: t.description, schema: t.schema },
    ) as StructuredToolInterface;
}

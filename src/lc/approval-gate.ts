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

export function approvalGate(meta: ApprovalMeta): (t: StructuredToolInterface) => StructuredToolInterface {
  return (t: StructuredToolInterface) =>
    tool(
      async (args: unknown) => {
        try {
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

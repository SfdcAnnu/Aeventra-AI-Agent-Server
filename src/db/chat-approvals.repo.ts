/**
 * ChatApproval — Phase 7 approval-as-suspension for CHAT mode. A tool node
 * marked requiresApproval never executes inline: the call is parked here as
 * a durable row (the turn continues; the model tells the user the action is
 * awaiting approval), and POST /api/chat/approvals/decide later executes or
 * rejects it. Trigger-mode approvals already work this way via AgentRun's
 * WAITING_APPROVAL status — this brings chat tools to parity.
 *
 * Expiry is lazy (rows past timeoutAt flip to 'Expired' on the way through
 * a read), same no-sweeper stance as ws-tickets.repo.ts.
 */
import { prisma } from './client';
import type { ChatApproval, Prisma } from '@prisma/client';

const timeoutHours = (() => {
  const n = Number(process.env.CHAT_APPROVAL_TIMEOUT_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 24;
})();

export const ChatApprovalsRepo = {
  async create(input: {
    orgId: string;
    agentApiName: string;
    planVersion?: string | null;
    sessionId: string;
    userId: string;
    recordContextId?: string | null;
    recordContextType?: string | null;
    toolName: string;
    argsJson: unknown;
  }): Promise<ChatApproval> {
    return prisma.chatApproval.create({
      data: {
        ...input,
        argsJson: (input.argsJson ?? {}) as Prisma.InputJsonValue,
        timeoutAt: new Date(Date.now() + timeoutHours * 3_600_000),
      },
    });
  },

  async listForOrg(orgId: string, opts: { status?: string; sessionId?: string; limit?: number } = {}): Promise<ChatApproval[]> {
    await expireStale(orgId);
    return prisma.chatApproval.findMany({
      where: {
        orgId,
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(opts.limit ?? 50, 200),
    });
  },

  /** Org-scoped lookup — a row can only ever be read/decided by its own org. */
  async findForOrg(orgId: string, id: string): Promise<ChatApproval | null> {
    await expireStale(orgId);
    return prisma.chatApproval.findFirst({ where: { id, orgId } });
  },

  /**
   * Atomically claim a Pending row for a decision — the WHERE guards status,
   * so two concurrent decide calls can never both proceed.
   */
  async claimPending(orgId: string, id: string, decision: 'Approved' | 'Rejected', decidedBy?: string | null): Promise<boolean> {
    const r = await prisma.chatApproval.updateMany({
      where: { id, orgId, status: 'Pending', timeoutAt: { gt: new Date() } },
      data: { status: decision, decidedBy: decidedBy ?? null, decidedAt: new Date() },
    });
    return r.count === 1;
  },

  async recordExecution(id: string, ok: boolean, resultText: string): Promise<void> {
    await prisma.chatApproval.update({
      where: { id },
      data: { status: ok ? 'Executed' : 'Failed', resultText: resultText.slice(0, 8000) },
    });
  },
};

async function expireStale(orgId: string): Promise<void> {
  await prisma.chatApproval.updateMany({
    where: { orgId, status: 'Pending', timeoutAt: { lt: new Date() } },
    data: { status: 'Expired' },
  }).catch(() => null);
}

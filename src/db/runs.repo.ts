/**
 * Org-scoped CRUD for durable agent runs. Every run gets a row (cheap audit
 * trail); pause/resume is just the same row living longer with a status
 * change, not a special path.
 */
import { prisma } from './client';
import type { AgentRun, Prisma } from '@prisma/client';

export const RunsRepo = {
  async create(args: {
    orgId: string;
    agentApiName: string;
    correlationId: string;
    recordId?: string | null;
    userId?: string | null;
    contextState: unknown;
    aliases: unknown;
    frontier: unknown;
    visited: unknown;
    engineOverrideJson?: unknown;
  }): Promise<AgentRun> {
    return prisma.agentRun.create({
      data: {
        orgId: args.orgId,
        agentApiName: args.agentApiName,
        correlationId: args.correlationId,
        recordId: args.recordId ?? null,
        userId: args.userId ?? null,
        status: 'RUNNING',
        contextState: args.contextState as Prisma.InputJsonValue,
        aliases: args.aliases as Prisma.InputJsonValue,
        frontier: args.frontier as Prisma.InputJsonValue,
        visited: args.visited as Prisma.InputJsonValue,
        engineOverrideJson: (args.engineOverrideJson ?? null) as Prisma.InputJsonValue,
      },
    });
  },

  async getById(orgId: string, id: string): Promise<AgentRun | null> {
    return prisma.agentRun.findFirst({ where: { id, orgId } });
  },

  async getByApprovalToken(approvalToken: string): Promise<AgentRun | null> {
    return prisma.agentRun.findUnique({ where: { approvalToken } });
  },

  /**
   * The generic "resume by record" lookup — the hook a customer's own
   * automation calls after their Approval Process decides something. In
   * ordinary use a record only ever has one pending approval (and one
   * paused run) at a time; ordered by most-recently-paused first purely as
   * a sane tie-break if old/abandoned test runs ever leave more than one
   * behind.
   */
  async getPendingApprovalByRecord(orgId: string, recordId: string): Promise<AgentRun | null> {
    return prisma.agentRun.findFirst({
      where: { orgId, recordId, status: 'WAITING_APPROVAL' },
      orderBy: { updatedAt: 'desc' },
    });
  },

  /** Snapshot the engine's current progress — called after every node. */
  async checkpoint(id: string, args: {
    contextState: unknown; aliases: unknown; frontier: unknown; visited: unknown;
  }): Promise<void> {
    await prisma.agentRun.update({
      where: { id },
      data: {
        contextState: args.contextState as Prisma.InputJsonValue,
        aliases: args.aliases as Prisma.InputJsonValue,
        frontier: args.frontier as Prisma.InputJsonValue,
        visited: args.visited as Prisma.InputJsonValue,
      },
    });
  },

  async markWaiting(id: string, args: { resumeAt: Date; pausedNodeId: string }): Promise<void> {
    await prisma.agentRun.update({
      where: { id },
      data: { status: 'WAITING', resumeAt: args.resumeAt, pausedNodeId: args.pausedNodeId },
    });
  },

  async markWaitingApproval(id: string, args: { approvalToken: string; pausedNodeId: string; timeoutAt?: Date | null }): Promise<void> {
    await prisma.agentRun.update({
      where: { id },
      data: {
        status: 'WAITING_APPROVAL',
        approvalToken: args.approvalToken,
        pausedNodeId: args.pausedNodeId,
        timeoutAt: args.timeoutAt ?? null,
      },
    });
  },

  async markRunning(id: string): Promise<void> {
    await prisma.agentRun.update({
      where: { id },
      data: { status: 'RUNNING', resumeAt: null, approvalToken: null, timeoutAt: null, pausedNodeId: null },
    });
  },

  async markDone(id: string, status: 'SUCCESS' | 'ERROR', lastError?: string | null): Promise<void> {
    await prisma.agentRun.update({
      where: { id },
      data: { status, lastError: lastError ?? null, resumeAt: null },
    });
  },

  async dueWaits(limit = 50): Promise<AgentRun[]> {
    return prisma.agentRun.findMany({
      where: { status: 'WAITING', resumeAt: { lte: new Date() } },
      take: limit,
      orderBy: { resumeAt: 'asc' },
    });
  },

  async overdueApprovals(limit = 50): Promise<AgentRun[]> {
    return prisma.agentRun.findMany({
      where: { status: 'WAITING_APPROVAL', timeoutAt: { lte: new Date() } },
      take: limit,
      orderBy: { timeoutAt: 'asc' },
    });
  },

  async addStep(runId: string, args: {
    nodeId: string; nodeLabel?: string | null; nodeSubType: string; input?: unknown;
    success: boolean; output?: unknown; error?: string | null;
  }): Promise<void> {
    await prisma.runStep.create({
      data: {
        runId,
        nodeId: args.nodeId,
        nodeLabel: args.nodeLabel ?? null,
        nodeSubType: args.nodeSubType,
        input: (args.input ?? null) as Prisma.InputJsonValue,
        success: args.success,
        output: (args.output ?? null) as Prisma.InputJsonValue,
        error: args.error ?? null,
        finishedAt: new Date(),
      },
    });
  },

  /** All steps for a run, oldest first — the per-node trace shown in Salesforce. */
  async listSteps(runId: string) {
    return prisma.runStep.findMany({ where: { runId }, orderBy: { startedAt: 'asc' } });
  },

  async getByCorrelationId(orgId: string, correlationId: string) {
    return prisma.agentRun.findFirst({ where: { orgId, correlationId } });
  },
};

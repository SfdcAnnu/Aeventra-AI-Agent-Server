import { randomUUID } from 'crypto';
import type { Connection } from 'jsforce';
import { ExecutionContext } from './context';
import { buildGraph, findTrigger, nextNodes } from './graph';
import type { GraphAdjacency } from './graph';
import { getExecutor, echoExecutor } from '../nodes/registry';
import { RunsRepo } from '../db/runs.repo';
import { logger } from '../logger';
import type { AgentDefinition, AgentExecuteRequest, AgentNode, GraphResult, NodePause, NodeResult } from '../types';

// Side-effect imports — registers all node executors
import '../nodes/trigger';
import '../nodes/logic';
import '../nodes/end';
import '../nodes/ai';
import '../nodes/ai-step';   // registers claude/gpt4 — headless chat-adapter reuse (overrides ai.ts placeholders)
import '../nodes/action';
import '../nodes/call-tool'; // generic deterministic tool-call action node
import '../nodes/channel';
import '../nodes/tool-catalogs';

const MAX_NODES_PER_RUN = 100; // safety cap, per execution burst (resets on resume)
const MAX_LOOP_ITERATIONS_HARD_CAP = 100;

export async function runAgent(args: {
  agent: AgentDefinition;
  request: AgentExecuteRequest;
  conn: Connection;
}): Promise<GraphResult> {
  const { agent, request, conn } = args;
  const correlationId = randomUUID();
  const start = Date.now();

  const ctx = new ExecutionContext({
    correlationId,
    agent,
    recordId: request.recordId,
    orgId: request.orgId,
    userId: request.userId,
    inputPayload: request.inputPayload,
    conn,
    engineOverride: request.engineOverride,
  });

  const graph = buildGraph(agent);
  ctx.graph = graph;
  await ctx.loadStaticContext();
  const trigger = findTrigger(graph);
  if (!trigger) {
    return errorResult(correlationId, start, 'No trigger node found in agent definition');
  }

  const run = await RunsRepo.create({
    orgId: request.orgId,
    agentApiName: agent.apiName,
    correlationId,
    recordId: request.recordId,
    userId: request.userId,
    contextState: ctx.serializeState(),
    aliases: ctx.serializeAliases(),
    frontier: [trigger.id],
    visited: [],
    // Without this, a resumed run always rebuilds its ExecutionContext with
    // engineOverride: undefined (see resumeRunById below) — any AI node
    // that only ever executes AFTER a pause/resume would silently lose the
    // credential the run started with, even though one was resolved fine.
    engineOverrideJson: request.engineOverride,
  });
  ctx.runId = run.id;

  const outcome = await runLoop({ ctx, graph, queue: [trigger], visited: new Set<string>(), runId: run.id });
  return finalizeResult({ ctx, correlationId, start, outcome, runId: run.id });
}

/**
 * Continues a paused run — a Wait whose time has come, or an Approval
 * that just got decided. Rebuilds ExecutionContext from the persisted
 * snapshot and picks the BFS back up exactly where it left off.
 *
 * Re-fetches the agent definition fresh (via the caller-supplied loader)
 * rather than trusting anything cached from before the pause — if the
 * agent was edited while paused, resume uses the latest saved graph.
 */
export async function resumeRunById(args: {
  orgId: string;
  runId: string;
  agent: AgentDefinition;
  conn: Connection;
  /** Required when resuming a WAITING_APPROVAL run — ignored for WAITING (wait). */
  decision?: 'approved' | 'rejected';
}): Promise<GraphResult> {
  const { orgId, runId, agent, conn } = args;
  const start = Date.now();

  const run = await RunsRepo.getById(orgId, runId);
  if (!run) throw new Error(`AgentRun ${runId} not found for org ${orgId}`);
  if (run.status !== 'WAITING' && run.status !== 'WAITING_APPROVAL') {
    throw new Error(`AgentRun ${runId} is not paused (status: ${run.status})`);
  }
  if (run.status === 'WAITING_APPROVAL' && !args.decision) {
    throw new Error('A decision (approved/rejected) is required to resume an approval-paused run.');
  }

  const ctx = new ExecutionContext({
    correlationId: run.correlationId,
    agent,
    recordId: run.recordId ?? '',
    orgId: run.orgId,
    userId: run.userId ?? '',
    inputPayload: {},
    conn,
    engineOverride: (run.engineOverrideJson as ExecutionContext['engineOverride']) ?? undefined,
  });
  ctx.runId = run.id;
  ctx.hydrateState(run.contextState as Parameters<ExecutionContext['hydrateState']>[0]);
  ctx.hydrateAliases(run.aliases as Record<string, string>);

  const graph = buildGraph(agent);
  ctx.graph = graph;
  await ctx.loadStaticContext();

  // The paused node's own downstream was never queued at pause time (the
  // engine returns before computing it) — seed it now from the decision
  // (approval) or the 'out' port (wait).
  const pausedNode = run.pausedNodeId ? graph.byId.get(run.pausedNodeId) : undefined;
  let seeded: AgentNode[] = [];
  if (pausedNode) {
    const port = run.status === 'WAITING_APPROVAL' ? (args.decision as string) : 'out';
    seeded = nextNodes(graph, pausedNode.id, port);
    if (run.status === 'WAITING_APPROVAL') {
      ctx.state.set(pausedNode.id, {
        ...(ctx.state.get(pausedNode.id) ?? {}),
        decision: args.decision,
        decidedAt: new Date().toISOString(),
      });
    }
  }

  const savedFrontierIds = (run.frontier as string[]) ?? [];
  const savedFrontier = savedFrontierIds.map((id) => graph.byId.get(id)).filter((n): n is AgentNode => !!n);
  const queue = [...seeded, ...savedFrontier];
  const visited = new Set<string>((run.visited as string[]) ?? []);

  await RunsRepo.markRunning(run.id);
  const outcome = await runLoop({ ctx, graph, queue, visited, runId: run.id });
  return finalizeResult({ ctx, correlationId: run.correlationId, start, outcome, runId: run.id });
}

interface LoopOutcome {
  paused?: NodePause & { nodeId: string };
  lastError?: string;
  lastAiResult?: NodeResult;
}

/**
 * The BFS engine, extracted so both a fresh run and a resumed run share it,
 * and so a Loop node's body can recurse into it for a nested per-iteration
 * pass. Persists a RunStep + a full checkpoint after every node — resuming
 * after a crash (not just a deliberate pause) picks up from the last
 * completed node, never re-running it (at-least-once, not at-most-once,
 * but idempotent executors make that safe in practice).
 */
async function runLoop(args: {
  ctx: ExecutionContext;
  graph: GraphAdjacency;
  queue: AgentNode[];
  visited: Set<string>;
  runId: string;
  insideLoop?: boolean;
}): Promise<LoopOutcome> {
  const { ctx, graph, queue, visited, runId, insideLoop } = args;
  let lastAiResult: NodeResult | undefined;
  let lastError: string | undefined;
  let nodesRun = 0;

  while (queue.length > 0) {
    if (nodesRun >= MAX_NODES_PER_RUN) {
      lastError = `Hit MAX_NODES_PER_RUN (${MAX_NODES_PER_RUN}) — likely a loop in the graph`;
      break;
    }

    const node = queue.shift()!;
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    if (!node.isEnabled) continue;
    if (node.nodeType === 'catalog' && ctx.consumedCatalogIds.has(node.id)) continue;

    if (node.nodeSubType === 'loop') {
      if (insideLoop) {
        lastError = 'Nested loops are not supported in this version.';
        break;
      }
      nodesRun++;
      const loopResult = await runLoopNode(node, ctx, graph, runId);
      ctx.recordResult(node, loopResult);
      await persistStep(runId, node, loopResult);
      if (!loopResult.success) {
        lastError = loopResult.error ?? 'loop failed';
        break;
      }
      queue.push(...nextNodes(graph, node.id, 'done'));
      await checkpoint(ctx, runId, queue, visited);
      continue;
    }

    const executor = getExecutor(node.nodeSubType) ?? echoExecutor;
    let result: NodeResult;
    try {
      result = await executor(node, ctx);
    } catch (err) {
      logger.error({ err, nodeId: node.id, subType: node.nodeSubType }, 'node_executor_threw');
      result = {
        nodeId: node.id,
        nodeSubType: node.nodeSubType,
        success: false,
        error: (err as Error).message,
      };
    }

    nodesRun++;
    ctx.recordResult(node, result);
    await persistStep(runId, node, result);

    if (!result.success) {
      lastError = result.error ?? 'unknown error';
      break;
    }
    if (node.nodeType === 'ai') lastAiResult = result;

    if (result.pause) {
      if (insideLoop) {
        lastError = `${result.pause.kind === 'wait' ? 'Wait' : 'Approval'} nodes are not supported inside a Loop body.`;
        break;
      }
      await checkpoint(ctx, runId, queue, visited);
      if (result.pause.kind === 'wait') {
        await RunsRepo.markWaiting(runId, { resumeAt: new Date(result.pause.resumeAt!), pausedNodeId: node.id });
      } else {
        await RunsRepo.markWaitingApproval(runId, {
          approvalToken: result.pause.approvalToken!,
          pausedNodeId: node.id,
          timeoutAt: result.pause.timeoutAt ? new Date(result.pause.timeoutAt) : null,
        });
      }
      return { paused: { ...result.pause, nodeId: node.id }, lastAiResult };
    }

    const port = result.nextPort ?? 'out';
    const downstream = nextNodes(graph, node.id, port);
    for (const next of downstream) {
      if (next.nodeType === 'catalog' && ctx.consumedCatalogIds.has(next.id)) {
        queue.push(...nextNodes(graph, next.id, 'out'));
      } else {
        queue.push(next);
      }
    }

    if (!insideLoop) await checkpoint(ctx, runId, queue, visited);
  }

  return { lastError, lastAiResult };
}

/** One loop node = one nested BFS pass per collection item, over whatever is wired to its 'each' port. */
async function runLoopNode(node: AgentNode, ctx: ExecutionContext, graph: GraphAdjacency, runId: string): Promise<NodeResult> {
  const config = node.config as { collectionVar?: string; iteratorVar?: string; maxIterations?: number };
  const iteratorVar = String(config.iteratorVar ?? 'item').trim() || 'item';
  const maxIterations = Math.min(Math.max(1, Number(config.maxIterations) || 25), MAX_LOOP_ITERATIONS_HARD_CAP);

  const path = extractInterpolationPath(String(config.collectionVar ?? ''));
  const resolved = path ? ctx.resolve(path) : undefined;
  const items: unknown[] = Array.isArray(resolved) ? resolved : [];

  const bodyStart = nextNodes(graph, node.id, 'each');
  if (items.length === 0 || bodyStart.length === 0) {
    return {
      nodeId: node.id,
      nodeSubType: 'loop',
      success: true,
      output: {
        iterationCount: 0,
        note: items.length === 0
          ? `Collection variable "${config.collectionVar ?? ''}" resolved to zero items (or was not a list) — loop body skipped.`
          : 'Nothing wired to the each port — loop body skipped.',
      },
    };
  }

  const cappedCount = Math.min(items.length, maxIterations);
  const iterNodeId = `__loop_${node.id}_iter`;
  for (let i = 0; i < cappedCount; i++) {
    const item = items[i];
    const itemRecord: Record<string, unknown> = (item && typeof item === 'object' && !Array.isArray(item))
      ? (item as Record<string, unknown>)
      : { value: item };
    ctx.recordResult(
      { id: iterNodeId, nodeType: iteratorVar },
      { nodeId: iterNodeId, nodeSubType: '_loop_iterator', success: true, output: itemRecord },
    );

    const bodyOutcome = await runLoop({
      ctx, graph, queue: [...bodyStart], visited: new Set<string>(), runId, insideLoop: true,
    });
    if (bodyOutcome.lastError) {
      return { nodeId: node.id, nodeSubType: 'loop', success: false, error: `Loop iteration ${i + 1} of ${cappedCount}: ${bodyOutcome.lastError}` };
    }
  }

  return {
    nodeId: node.id,
    nodeSubType: 'loop',
    success: true,
    output: { iterationCount: cappedCount, totalItems: items.length },
  };
}

/** `"{!path}"` → `"path"`; also accepts a bare path with no braces. */
function extractInterpolationPath(template: string): string {
  const trimmed = template.trim();
  const match = trimmed.match(/^\{!(.+)\}$/);
  return match ? match[1].trim() : trimmed;
}

async function persistStep(runId: string, node: AgentNode, result: NodeResult): Promise<void> {
  await RunsRepo.addStep(runId, {
    nodeId: node.id,
    nodeLabel: node.name ?? null,
    nodeSubType: node.nodeSubType,
    // The node's saved config, pre-interpolation — "what it was asked to
    // do." Executors interpolate {!...} tokens internally and don't
    // uniformly report the resolved values back out, so this is the
    // consistent, always-available definition of "input" across every
    // node type without having to touch every executor individually.
    input: node.config ?? null,
    success: result.success,
    output: result.output,
    error: result.error ?? null,
  }).catch((err) => logger.error({ err, runId, nodeId: node.id }, 'run_step_persist_failed'));
}

async function checkpoint(ctx: ExecutionContext, runId: string, queue: AgentNode[], visited: Set<string>): Promise<void> {
  await RunsRepo.checkpoint(runId, {
    contextState: ctx.serializeState(),
    aliases: ctx.serializeAliases(),
    frontier: queue.map((n) => n.id),
    visited: Array.from(visited),
  }).catch((err) => logger.error({ err, runId }, 'run_checkpoint_failed'));
}

async function finalizeResult(args: {
  ctx: ExecutionContext;
  correlationId: string;
  start: number;
  outcome: LoopOutcome;
  runId: string;
}): Promise<GraphResult> {
  const { ctx, correlationId, start, outcome, runId } = args;
  const durationMs = Date.now() - start;

  if (outcome.paused) {
    const status = outcome.paused.kind === 'wait' ? 'WAITING' : 'WAITING_APPROVAL';
    return {
      success: true,
      correlationId,
      agentStatus: status,
      agentScore: outcome.lastAiResult?.score,
      agentPriority: outcome.lastAiResult?.priority,
      agentReason: outcome.paused.kind === 'wait' ? `Waiting until ${outcome.paused.resumeAt}` : 'Waiting for approval',
      agentOutputPayload: Object.fromEntries(ctx.state.entries()),
      toolsUsed: Array.from(ctx.toolsUsed),
      durationMs,
      runId,
      approvalToken: outcome.paused.approvalToken,
    };
  }

  const success = !outcome.lastError;
  await RunsRepo.markDone(runId, success ? 'SUCCESS' : 'ERROR', outcome.lastError ?? null);

  return {
    success,
    correlationId,
    agentStatus: success ? 'SUCCESS' : 'ERROR',
    agentScore: outcome.lastAiResult?.score,
    agentPriority: outcome.lastAiResult?.priority,
    agentReason: outcome.lastError ?? outcome.lastAiResult?.reason,
    agentOutputPayload: Object.fromEntries(ctx.state.entries()),
    toolsUsed: Array.from(ctx.toolsUsed),
    durationMs,
    runId,
  };
}

function errorResult(correlationId: string, start: number, reason: string): GraphResult {
  return {
    success: false,
    correlationId,
    agentStatus: 'ERROR',
    agentReason: reason,
    agentOutputPayload: {},
    toolsUsed: [],
    durationMs: Date.now() - start,
  };
}

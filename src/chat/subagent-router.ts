/**
 * subagent-router — resolves the graph-based Topics/Actions replacement.
 *
 * A chat agent's top-level 'ai' node has directly-attached graph children
 * (via CanvasJson__c, 'tool' port) of two kinds:
 *   - 'tool' nodes  — a real, named, callable action, described directly on
 *     AgentNode__c.ConfigJson__c (the old AgentTopic__c/AgentAction__c model
 *     this replaced has been migrated away and removed).
 *   - 'subagent' nodes — a Level-2 domain-expert with its OWN system prompt/
 *     model, offered to the top-level model as a callable HANDOFF tool.
 *
 * Routing is real function-calling (confirmed with the user, not a separate
 * cheap-classifier pre-step): the top-level adapter call sees plain tools
 * AND handoff tools side by side in the SAME request, and the model's own
 * reasoning picks. See chat-engine.ts for the two-call orchestration this
 * feeds into.
 *
 * Hard 2-tier depth cap: resolveSubagentActions deliberately never builds
 * handoff tools for a subagent's own turn, so even if a subagent node has
 * its own connected subagent children in the graph, they're simply never
 * surfaced — no recursion, no depth tracking needed.
 */
import type { AgentDefinition, AgentNode, AgentAction } from '../types';
import { nextNodes, type GraphAdjacency } from '../orchestrator/graph';

export interface HandoffToolDef {
  /** Provider-safe function/tool name — never the raw node label. */
  name: string;
  description: string;
  subagentNodeId: string;
}

export interface TopLevelResolution {
  topLevelActions: AgentAction[];
  handoffTools: HandoffToolDef[];
}

/**
 * Provider tool names must be safe identifiers (roughly ^[a-zA-Z0-9_-]+$,
 * length-limited) — a human node label like "Escalation / Human Handoff"
 * isn't valid as-is. Suffixed with a short slice of the node id so two
 * similarly-named subagents never collide — reserve room for that suffix
 * BEFORE truncating the sanitized name, not after. Truncating the whole
 * concatenated string (name first, suffix appended, then sliced to the
 * length limit) would cut the suffix off first for any long enough name,
 * defeating the one thing it exists to guarantee.
 */
function toolNameSlug(prefix: string, name: string, nodeId: string): string {
  const suffix = nodeId.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, '');
  const maxTotal = 64;
  const fixedLen = prefix.length + 2 + suffix.length; // prefix + '_' + base + '_' + suffix
  const maxBaseLen = Math.max(maxTotal - fixedLen, 1);
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, maxBaseLen);
  return `${prefix}_${base || 'node'}_${suffix}`;
}

/** Reshapes a 'tool' AgentNode's ConfigJson__c into the same AgentAction
 *  shape mergeActionsIntoConnectors already knows how to fold into a
 *  connector's allowedTools/customTools — zero changes needed there. */
function nodeToAgentAction(node: AgentNode): AgentAction {
  const cfg = node.config as {
    description?: string;
    actionType?: string;
    toolName?: string;
    connectorId?: string;
    requiresApproval?: boolean;
  };
  return {
    id: node.id,
    name: node.name,
    description: cfg.description ?? '',
    actionType: (cfg.actionType as AgentAction['actionType']) ?? 'MCP',
    toolName: cfg.toolName ?? '',
    connectorId: cfg.connectorId ?? null,
    isEnabled: node.isEnabled,
    requiresApproval: cfg.requiresApproval === true,
  };
}

/**
 * What the TOP-LEVEL model sees this turn: its own directly-attached 'tool'
 * nodes (merged into connectors, exactly like today's always-on actions),
 * plus a handoff tool declaration for each directly-attached 'subagent'
 * node. An agent with zero subagent/tool children (a vanilla agent, or one
 * that was never migrated because it never had Topics/Actions) resolves to
 * empty lists here — byte-for-byte the same request shape as before this
 * change, since mergeActionsIntoConnectors is a no-op on an empty list and
 * an empty handoffTools list means the adapters add no extra tool defs.
 */
export function resolveTopLevelToolsAndSubagents(
  agent: AgentDefinition,
  graph: GraphAdjacency,
  aiNode: AgentNode,
): TopLevelResolution {
  const downstream = nextNodes(graph, aiNode.id, 'tool').filter(n => n.isEnabled);

  const topLevelActions: AgentAction[] = [];
  const handoffTools: HandoffToolDef[] = [];

  for (const node of downstream) {
    if (node.nodeType === 'tool') {
      topLevelActions.push(nodeToAgentAction(node));
    } else if (node.nodeType === 'subagent') {
      const cfg = node.config as { routingDescription?: string };
      const description = (cfg.routingDescription ?? '').trim() ||
        `Hand off to the "${node.name}" specialist for this part of the conversation.`;
      handoffTools.push({
        name: toolNameSlug('handoff_to', node.name, node.id),
        description,
        subagentNodeId: node.id,
      });
    }
    // Other node types (e.g. 'catalog') attached directly to the ai node's
    // 'tool' port would be unusual — today's catalog config is read via
    // discoverAllowedTools/the connectors payload, not this path. Ignored
    // here rather than erroring, since it isn't this function's concern.
  }

  return { topLevelActions, handoffTools };
}

/**
 * What a CHOSEN subagent's own turn sees — its directly-attached 'tool'
 * nodes only. No handoffTools are built for a subagent (see module doc —
 * this IS the depth cap).
 */
export function resolveSubagentActions(
  graph: GraphAdjacency,
  subagentNode: AgentNode,
): AgentAction[] {
  return nextNodes(graph, subagentNode.id, 'tool')
    .filter(n => n.isEnabled && n.nodeType === 'tool')
    .map(nodeToAgentAction);
}

/**
 * Reshapes a 'subagent' AgentNode into an AgentNode the SAME adapter
 * functions can run a turn against — a subagent isn't literally an 'ai'
 * node, but it carries the same config shape (model, systemPrompt) the
 * adapters already read via `aiNode.config`, so this is a pure relabel, not
 * new adapter logic. Falls back to the top-level node's own provider when
 * the subagent wasn't explicitly given one (e.g. freshly migrated).
 *
 * KNOWN LIMITATION: credential resolution (ChatTurnRequest.engineOverride)
 * is resolved ONCE by Apex for the top-level node's NodeSubType__c and
 * reused as-is for the subagent's call. A same-provider subagent works
 * correctly. A subagent on a DIFFERENT provider than the top-level
 * node throws inside engine-resolver.ts's resolveEngine() — there is
 * deliberately NO server-side .env fallback there (see that file's own
 * header comment) — and chat-engine.ts catches this around the subagent
 * dispatch specifically so it degrades to an apology message instead of
 * 500ing the whole turn (see runChatTurn's try/catch around the second
 * dispatchToAdapter call). Fixing the root cause properly means Apex
 * resolving+sending one engineOverride per distinct provider used anywhere
 * in the graph — a bigger change, left for when a real mixed-provider agent
 * actually needs it.
 */
export function toSyntheticAiNode(subagentNode: AgentNode, topLevelAiNode: AgentNode): AgentNode {
  const cfg = subagentNode.config as { systemPrompt?: string; model?: string };
  return {
    id: subagentNode.id,
    name: subagentNode.name,
    nodeType: 'ai',
    nodeSubType: subagentNode.nodeSubType || topLevelAiNode.nodeSubType,
    config: { systemPrompt: cfg.systemPrompt ?? '', model: cfg.model },
    positionX: subagentNode.positionX,
    positionY: subagentNode.positionY,
    sortOrder: subagentNode.sortOrder,
    isEnabled: subagentNode.isEnabled,
    mcpServer: null,
    mcpTool: null,
  };
}

import type { AgentDefinition, AgentNode } from '../types';

/**
 * Resolves the runtime topology of a saved agent.
 *
 * `CanvasJson__c` stores connections by node-index (not record ID — node IDs
 * change on each save). We rebuild the adjacency map keyed by node id.
 */
export interface GraphAdjacency {
  /** node id → port → list of downstream node ids */
  nextByPort: Map<string, Map<string, string[]>>;
  /** node id → node */
  byId: Map<string, AgentNode>;
  /** node ids in sortOrder, for fallback fall-through */
  ordered: AgentNode[];
}

export function buildGraph(agent: AgentDefinition): GraphAdjacency {
  const nodes = [...agent.nodes].sort((a, b) => a.sortOrder - b.sortOrder);
  const byId = new Map<string, AgentNode>();
  nodes.forEach((n) => byId.set(n.id, n));

  const nextByPort = new Map<string, Map<string, string[]>>();
  const connections = agent.canvasJson?.connections ?? [];

  for (const c of connections) {
    const from = nodes[c.fromIndex];
    const to = nodes[c.toIndex];
    if (!from || !to) continue;
    if (!nextByPort.has(from.id)) nextByPort.set(from.id, new Map());
    const portMap = nextByPort.get(from.id)!;
    const port = c.fromPort || 'out';
    if (!portMap.has(port)) portMap.set(port, []);
    portMap.get(port)!.push(to.id);
  }

  return { nextByPort, byId, ordered: nodes };
}

export function findTrigger(graph: GraphAdjacency): AgentNode | undefined {
  return graph.ordered.find((n) => n.nodeType === 'trigger');
}

export function nextNodes(
  graph: GraphAdjacency,
  fromNodeId: string,
  port: string,
): AgentNode[] {
  const portMap = graph.nextByPort.get(fromNodeId);
  if (!portMap) return [];
  const ids = portMap.get(port) ?? [];
  return ids.map((id) => graph.byId.get(id)).filter((n): n is AgentNode => !!n);
}

import type { AgentNode, NodeResult } from '../types';
import type { ExecutionContext } from '../orchestrator/context';

export type NodeExecutor = (node: AgentNode, ctx: ExecutionContext) => Promise<NodeResult>;

const registry = new Map<string, NodeExecutor>();

export function register(nodeSubType: string, executor: NodeExecutor): void {
  registry.set(nodeSubType, executor);
}

export function getExecutor(nodeSubType: string): NodeExecutor | undefined {
  return registry.get(nodeSubType);
}

/** Default executor used when no specific one is registered — echoes config. */
export const echoExecutor: NodeExecutor = async (node) => ({
  nodeId: node.id,
  nodeSubType: node.nodeSubType,
  success: true,
  output: { ...node.config, echoed: true },
});

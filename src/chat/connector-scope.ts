/**
 * Which tools each node's request carries, per MCP connection.
 *
 * Two kinds of connection reach the runtime:
 *
 *   catalog  — a tool catalog node on the canvas. It is the agent's
 *              connection to a server AND, for agents built that way, the
 *              toolset: its allowedTools (empty = everything the server
 *              has) is what every node sees, plus that node's own tool
 *              nodes folded in. Unchanged behaviour.
 *
 *   nodes    — derived from tool nodes alone (tool-node-connectors.ts): no
 *              catalog node names the server, the tool nodes do. These are
 *              STRICT: a node's request carries exactly the tool nodes
 *              wired to that node for that server, and a node with none
 *              wired does not see the server at all. The router of a large
 *              agent never receives its specialists' tool definitions.
 *
 * Pure functions — no I/O — so the scoping rule has unit tests.
 */
import type { AgentAction } from '../types';
import type { ConnectorInput } from './adapters/types';

/** Provider key of the Archon server's own tool endpoint (platform tools). */
export const PLATFORM_PROVIDER = 'archon_platform';
/** Provider key of the Salesforce Metadata MCP server (catalog metadata row). */
export const METADATA_PROVIDER = 'salesforce_metadata';
/** Providers whose bearer is the caller's Salesforce token, not an OAuth connector row. */
export const SALESFORCE_TOKEN_PROVIDERS: ReadonlySet<string> = new Set(['salesforce_mcp', METADATA_PROVIDER]);

/** The connection an action belongs to. MCP tool nodes carry their server's
 *  provider key in connectorId (set by the builder's tool form); an empty one
 *  is the Salesforce Platform server, as every compiled agent assumes. Apex
 *  and Flow actions ride on the Salesforce Platform server as custom tools. */
export function providerOfAction(action: Pick<AgentAction, 'actionType' | 'connectorId'>): string | null {
  if (action.actionType === 'Prebuilt') return null;
  if (action.actionType === 'MCP') return action.connectorId?.trim() || 'salesforce_mcp';
  return 'salesforce_mcp';
}

/**
 * Fold ONE node's actions into the connections for that node's request.
 * Returns a new list; never mutates the input.
 */
export function mergeActionsIntoConnectors(
  connectors: ConnectorInput[] | undefined,
  actions: AgentAction[],
): ConnectorInput[] | undefined {
  if (!connectors) return connectors;
  const hasStrict = connectors.some(c => c.scope === 'nodes');
  if (actions.length === 0 && !hasStrict) return connectors;

  const list = connectors.map(c => ({
    ...c,
    allowedTools: [...c.allowedTools],
    customTools: c.customTools ? [...c.customTools] : [],
  }));
  const byProvider = new Map(list.map(c => [c.provider, c]));
  const strictNames = new Map<string, string[]>();
  for (const c of list) if (c.scope === 'nodes') strictNames.set(c.provider, []);

  for (const action of actions) {
    if (!action.isEnabled) continue;
    const provider = providerOfAction(action);
    if (!provider) continue;
    const target = byProvider.get(provider);
    if (!target) continue;

    if (action.actionType === 'MCP') {
      if (target.scope === 'nodes') {
        strictNames.get(provider)!.push(action.toolName);
      } else if (target.allowedTools.length > 0 && !target.allowedTools.includes(action.toolName)) {
        // Catalog semantics: a restriction list grows by the node's own
        // tools; an empty list already means "everything" and stays so.
        target.allowedTools.push(action.toolName);
      }
      continue;
    }
    // Apex / Flow → the Salesforce Platform server registers them as custom tools.
    const type = action.actionType === 'Apex' ? 'apex' : 'flow';
    if (!target.customTools!.some(t => t.type === type && t.name === action.toolName)) {
      target.customTools!.push({ type, name: action.toolName, label: action.name });
    }
  }

  return list
    .filter(c => c.scope !== 'nodes' || strictNames.get(c.provider)!.length > 0)
    .map(c => (c.scope === 'nodes' ? { ...c, allowedTools: [...new Set(strictNames.get(c.provider))] } : c));
}

/** The human message a turn runs on after an approved action executed —
 *  the client and the server agree on this text, so a later turn's history
 *  reads exactly what the model was given. */
export function continuationMessage(c: { toolName: string; resultText: string }): string {
  const result = (c.resultText ?? '').trim();
  return `[Approved action executed] ${c.toolName}: ${result.length > 4000 ? `${result.slice(0, 4000)} …` : result || '(no output)'}\n\n` +
    'Continue from where you left off. Do not repeat what was already said or done.';
}

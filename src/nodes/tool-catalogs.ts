import { register } from './registry';
import type { NodeExecutor } from './registry';

/**
 * Tool catalog nodes are DECLARATIONS, not execution steps.
 *
 * The engine "consumes" them when an upstream AI orchestrator node runs —
 * collecting their config (allowed tools, provider) into the AI's toolset.
 *
 * If for any reason a tool catalog node is reached as a normal BFS step
 * (no upstream AI consumed it), it runs as a no-op so the graph doesn't break.
 */

function noopCatalog(subType: string): NodeExecutor {
  return async (node) => ({
    nodeId: node.id,
    nodeSubType: subType,
    success: true,
    output: {
      note: 'Tool catalog node — no AI orchestrator upstream, so nothing to execute. Connect a Claude/GPT/Gemini node before this catalog.',
      catalogType: subType,
      allowedTools: Array.isArray(node.config?.allowedTools) ? node.config.allowedTools : [],
    },
  });
}

register('salesforce_crm_tools', noopCatalog('salesforce_crm_tools'));
register('storage_tools', noopCatalog('storage_tools'));
register('email_tools', noopCatalog('email_tools'));
register('channel_tools', noopCatalog('channel_tools'));

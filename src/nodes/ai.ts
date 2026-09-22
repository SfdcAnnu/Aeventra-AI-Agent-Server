import { register } from './registry';
import { resolveEngine } from '../chat/engine-resolver';
import {
  getCatalogTools,
  type CatalogSubType,
  type ToolDef,
} from '../mcp/dispatcher';
import type { NodeExecutor } from './registry';
import type { AgentNode } from '../types';
import type { ExecutionContext } from '../orchestrator/context';
import { logger } from '../logger';

/**
 * AI model nodes (gemini/einstein/sentiment/embed) are ORCHESTRATORS.
 *
 * claude/gpt4 moved to nodes/ai-step.ts (headless chat-adapter reuse —
 * Managed MCP + custom tools, same as chat mode). This file keeps the
 * providers that haven't been migrated yet.
 */

interface OrchestratorConfig {
  model?: string;
  instruction?: string;
  systemPrompt?: string;
  useKnowledgeBase?: boolean;
  temperature?: number;
  maxTokens?: number;
  captureReasoning?: boolean;
}

interface DiscoveredCatalog {
  catalogNode: AgentNode;
  catalogType: CatalogSubType;
  name: string;
  description: string;
  provider?: string;
  connectorId?: string;
  allowedTools: string[];
  tools: ToolDef[];
}

/** Looks at the AI node's downstream catalogs, marks them consumed, returns their config. */
function discoverCatalogs(node: AgentNode, ctx: ExecutionContext): DiscoveredCatalog[] {
  const downstream = ctx.consumeDownstreamCatalogs(node.id);
  const result: DiscoveredCatalog[] = [];
  for (const c of downstream) {
    const catalogType = c.nodeSubType as CatalogSubType;
    const allowedTools = Array.isArray(c.config?.allowedTools) ? (c.config.allowedTools as string[]) : [];
    if (allowedTools.length === 0) continue;
    const tools = getCatalogTools(catalogType, allowedTools);
    if (tools.length === 0) continue;
    result.push({
      catalogNode: c,
      catalogType,
      name: catalogType.replace(/_tools$/, ''),
      description: (c.config?.description as string) ?? '',
      provider: c.config?.provider as string | undefined,
      connectorId: (c.config?.connectorId as string) || undefined,
      allowedTools,
      tools,
    });
  }
  return result;
}


// ── Placeholders for less-used AI sub-types ─────────────────────────

register('einstein', async (node) => ({
  nodeId: node.id,
  nodeSubType: 'einstein',
  success: false,
  error: 'Einstein node — Salesforce Einstein API not wired yet.',
}));

register('sentiment', async (node) => ({
  nodeId: node.id,
  nodeSubType: 'sentiment',
  success: false,
  error: 'Sentiment node — provider not wired yet.',
}));

register('embed', async (node) => ({
  nodeId: node.id,
  nodeSubType: 'embed',
  success: false,
  error: 'Embed node — provider not wired yet.',
}));

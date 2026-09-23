/**
 * THE ORG SURVEY IS A LIST, NOT AN OPINION — SO IT IS NOT A MODEL CALL.
 *
 * The survey stage handed a deterministic gather (objects, invocables,
 * Flows, every MCP tool, knowledge bases) to gpt-4.1 and asked it to
 * return the same inventory "compressed": $0.03 and six seconds per
 * build to have a model re-type a list, with the chance of it dropping
 * the one tool the design needed. Everything the surveyor was told to
 * judge — what the integration user can ACTUALLY do — is already in the
 * flags the gather returns; the model had no other source.
 *
 * Same output keys as the model produced, so the matcher, the gap
 * reporter and the build detail screen read it unchanged.
 */
import type { InvocableSummary, McpToolInventory, ObjectSummary } from './surveyor-tools';

export interface SurveyInput {
  objects: ObjectSummary[];
  invocables: InvocableSummary[];
  mcp: McpToolInventory[];
  knowledgeBases: Array<{ agentApiName: string; documents: number; ready: number }>;
  crud: Array<{ sobject: string; operations: string[] }>;
  /** Standard objects worth listing beside the org's custom ones. */
  coreObjects: Set<string>;
  maxObjects?: number;
}

export function inventoryFromGather(input: SurveyInput): Record<string, unknown> {
  const max = input.maxObjects ?? 120;
  const objects = input.objects
    .filter(o => o.custom || input.coreObjects.has(o.name))
    .slice(0, max)
    .map(o => ({ name: o.name, label: o.label, custom: o.custom, createable: o.createable, updateable: o.updateable, queryable: o.queryable }));

  const mcpTools: Array<{ connector: string; name: string; description: string }> = [];
  const unavailableServers: Array<{ connector: string; reason: string }> = [];
  for (const server of input.mcp) {
    if (server.error) { unavailableServers.push({ connector: server.provider, reason: server.error }); continue; }
    for (const t of server.tools) mcpTools.push({ connector: server.provider, name: t.name, description: (t.description ?? '').slice(0, 200) });
  }

  return {
    objects,
    invocableApex: input.invocables.filter(i => i.kind === 'apex').map(i => ({ name: i.name, label: i.label })),
    flows: input.invocables.filter(i => i.kind === 'flow').map(i => ({ name: i.name, label: i.label })),
    mcpTools,
    crudAvailable: input.crud,
    knowledgeBases: input.knowledgeBases,
    permissionGaps: [],
    excludedWithReason: unavailableServers.map(s => ({ name: s.connector, reason: `not connected: ${s.reason}` })),
    counts: {
      objects: objects.length,
      invocableApex: input.invocables.filter(i => i.kind === 'apex').length,
      flows: input.invocables.filter(i => i.kind === 'flow').length,
      mcpTools: mcpTools.length,
      knowledgeBases: input.knowledgeBases.length,
    },
  };
}

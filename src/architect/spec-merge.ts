/**
 * PATCH THE SPEC IN CODE; ASK THE MODEL ONLY FOR WHAT CHANGES.
 *
 * Two stages used to have a model re-emit the ENTIRE AgentSpec to change
 * part of it. The Prompt Engineer returned the whole graph with the
 * instructions filled in — up to 12,000 output tokens, a minute or two of
 * generation on gpt-4.1, and the chance to drop an edge the designer had
 * drawn, which then needed re-checking. A design that failed validation
 * or review was re-emitted from scratch, paying the large tier's reasoning
 * again for a graph that was mostly right.
 *
 * Both now return only their change and the merge happens here, where it
 * is free, deterministic and cannot lose anything it was not told to.
 */
import type { AgentSpec, SpecEdge, SpecNode } from './spec';

// ── The Prompt Engineer's answer ─────────────────────────────────────

export interface PromptMapResult {
  /** Nodes whose text was set. */
  applied: number;
  /** Ids in the answer that are not in the spec — the writer invented or misspelt them. */
  unknownIds: string[];
  /** Agent and sub-agent nodes still without instructions, tool nodes still without a description. */
  missing: string[];
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v : null);

/**
 * Apply `{instructions: {id: text}, descriptions: {id: text}}` to the spec
 * in place. A writer that returns the whole spec anyway (the old shape)
 * is read the same way, node by node, so nothing depends on which shape
 * the model chose.
 */
export function applyPromptMap(spec: AgentSpec, answer: unknown): PromptMapResult {
  const byId = new Map(spec.nodes.map(n => [n.id, n]));
  const unknown = new Set<string>();
  let applied = 0;

  const set = (id: string, field: 'instructions' | 'description', value: unknown) => {
    const v = text(value);
    if (v === null) return;
    const node = byId.get(id);
    if (!node) { unknown.add(id); return; }
    node[field] = v;
    applied++;
  };

  const a = (answer ?? {}) as Record<string, unknown>;
  if (Array.isArray(a.nodes)) {
    for (const raw of a.nodes as Array<Record<string, unknown>>) {
      if (!raw || typeof raw.id !== 'string') continue;
      set(raw.id, 'instructions', raw.instructions);
      set(raw.id, 'description', raw.description);
    }
  }
  for (const [field, map] of [['instructions', a.instructions], ['description', a.descriptions]] as const) {
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const [id, value] of Object.entries(map as Record<string, unknown>)) set(id, field, value);
    }
  }

  const missing: string[] = [];
  for (const n of spec.nodes) {
    if ((n.type === 'agent' || n.type === 'subagent') && !text(n.instructions)) missing.push(`${n.id} (instructions)`);
    if (n.type === 'tool' && !text(n.description)) missing.push(`${n.id} (description)`);
  }
  return { applied, unknownIds: [...unknown], missing };
}

// ── The designer's patch ─────────────────────────────────────────────

export interface SpecPatch {
  /** Full node objects to add, or to replace the node with the same id. */
  nodes?: SpecNode[];
  removeNodeIds?: string[];
  /** The complete edge list, when any edge changes. Omitted = unchanged. */
  edges?: SpecEdge[];
}

export interface SpecPatchResult {
  spec: AgentSpec;
  /** Ids added or replaced — the nodes whose prompts need writing again. */
  changedIds: string[];
  removedIds: string[];
  edgesReplaced: boolean;
}

/** Whether the answer has anything a patch could carry. */
export function isSpecPatch(answer: unknown): answer is SpecPatch {
  const a = answer as Record<string, unknown> | null;
  if (!a || typeof a !== 'object') return false;
  return Array.isArray(a.nodes) || Array.isArray(a.removeNodeIds) || Array.isArray(a.edges);
}

/**
 * A new spec with the patch applied; the original is not touched. A node
 * in the patch replaces the node with its id, or is appended. Removing a
 * node also removes the edges that touch it. Edges are replaced wholesale
 * only when the patch carries them.
 */
export function applySpecPatch(spec: AgentSpec, patch: SpecPatch): SpecPatchResult {
  const next: AgentSpec = structuredClone(spec);
  const changedIds: string[] = [];
  const removedIds: string[] = [];

  const remove = new Set((patch.removeNodeIds ?? []).filter((id): id is string => typeof id === 'string'));
  if (remove.size > 0) {
    next.nodes = next.nodes.filter(n => {
      if (!remove.has(n.id)) return true;
      removedIds.push(n.id);
      return false;
    });
    next.edges = next.edges.filter(e => !remove.has(e.from) && !remove.has(e.to));
  }

  for (const node of patch.nodes ?? []) {
    if (!node || typeof node.id !== 'string') continue;
    const i = next.nodes.findIndex(n => n.id === node.id);
    if (i >= 0) next.nodes[i] = node;
    else next.nodes.push(node);
    changedIds.push(node.id);
  }

  let edgesReplaced = false;
  if (Array.isArray(patch.edges)) {
    next.edges = patch.edges;
    edgesReplaced = true;
  }
  return { spec: next, changedIds, removedIds, edgesReplaced };
}

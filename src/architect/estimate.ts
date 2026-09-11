/**
 * Deterministic cost and latency estimator for an AgentSpec — a straight
 * port of the design package's tools/estimate.py. No model involved: the
 * Flow Designer must hit a budget, and this tells it whether it did.
 * Using an LLM to estimate LLM cost is neither free, exact nor repeatable.
 *
 * Rates are per MILLION tokens. The defaults are placeholders — callers
 * may overwrite them from the live prices on the AI Models page.
 */
import type { AgentSpec, SpecNode, SpecEdge } from './spec';

export interface TierRates {
  in: number;
  out: number;
  cached: number;
  latency: number;
}

export const DEFAULT_TIER_RATES: Record<string, TierRates> = {
  large: { in: 15.0, out: 75.0, cached: 1.5, latency: 2.4 },
  medium: { in: 3.0, out: 15.0, cached: 0.3, latency: 1.2 },
  small: { in: 0.8, out: 4.0, cached: 0.08, latency: 0.5 },
};

const TOOL_SCHEMA_TOKENS = 150; // per tool exposed to a node
const TOOL_LATENCY = 0.9; // seconds per tool call
const CHARS_PER_TOKEN = 4;

// How many variable-input tokens a child sees, by context policy.
const POLICY_TOKENS: Record<string, number> = { isolated: 400, summary: 1200, windowed: 2600, full: 6000 };

export interface EstimateRow {
  node: string;
  tier: string;
  calls: number;
  prefixTokens: number;
  variableTokens: number;
  policy: string;
  outTokens: number;
  coldUsd: number;
  warmUsd: number;
  latencySeconds: number;
}

export interface Estimate {
  rows: EstimateRow[];
  subAgents: number;
  modelCallsPerRun: number;
  coldUsd: number;
  warmUsd: number;
  cacheSavingPct: number;
  latencySeconds: number;
  withinBudget: boolean;
  levers: string[];
}

/** Expected model calls for a node: one to decide, one per tool it will
 *  use (capped), one to synthesise. Deliberately conservative. */
function expectedCalls(node: SpecNode, toolCount: number): number {
  if (node.type !== 'agent' && node.type !== 'subagent') return 0;
  return 1 + Math.min(toolCount, 3) + (toolCount ? 1 : 0);
}

const tokens = (text: string | undefined): number => Math.floor((text ?? '').length / CHARS_PER_TOKEN);

export function estimateSpec(
  spec: AgentSpec,
  targets: { costUsd?: number; latencySeconds?: number } = {},
  rates: Record<string, TierRates> = DEFAULT_TIER_RATES,
): Estimate {
  const nodes = new Map(spec.nodes.map(n => [n.id, n]));
  const edges = spec.edges ?? [];

  const reach = new Map<string, SpecEdge[]>();
  for (const e of edges) {
    if (!reach.has(e.from)) reach.set(e.from, []);
    reach.get(e.from)!.push(e);
  }

  const rows: EstimateRow[] = [];
  let coldUsd = 0;
  let warmUsd = 0;

  for (const n of spec.nodes) {
    if (n.type !== 'agent' && n.type !== 'subagent') continue;
    const tier = n.model?.tier ?? 'large';
    const r = rates[tier] ?? rates.large;

    const outEdges = reach.get(n.id) ?? [];
    const toolCount = outEdges.filter(e => {
      const t = nodes.get(e.to)?.type;
      return t === 'tool' || t === 'tool_catalog';
    }).length;
    const subCount = outEdges.filter(e => nodes.get(e.to)?.type === 'subagent').length;

    const prefix = tokens(n.instructions) + (toolCount + subCount) * TOOL_SCHEMA_TOKENS;

    const inEdge = edges.find(e => e.to === n.id);
    const policy = inEdge?.contextPolicy ?? 'isolated';
    const variable = POLICY_TOKENS[policy] ?? 400;

    let outTok = n.model?.maxOutputTokens ?? 1024;
    outTok = Math.floor(outTok * 0.45); // models rarely fill the cap

    const calls = expectedCalls(n, toolCount + subCount);

    const cold = (calls * (prefix * r.in + variable * r.in + outTok * r.out)) / 1e6;
    const warm = (calls * (prefix * r.cached + variable * r.in + outTok * r.out)) / 1e6;
    coldUsd += cold;
    warmUsd += warm;

    rows.push({
      node: n.label,
      tier,
      calls,
      prefixTokens: prefix,
      variableTokens: variable,
      policy,
      outTokens: outTok,
      coldUsd: cold,
      warmUsd: warm,
      latencySeconds: calls * r.latency + toolCount * TOOL_LATENCY,
    });
  }

  // Latency: parallel siblings collapse to the slowest of the group.
  const root = spec.nodes.find(n => n.type === 'agent');
  const byLabel = new Map(rows.map(r => [r.node, r]));
  const par: number[] = [];
  const seq: number[] = [];
  for (const e of edges) {
    if (!root || e.from !== root.id || nodes.get(e.to)?.type !== 'subagent') continue;
    const r = byLabel.get(nodes.get(e.to)!.label);
    if (!r) continue;
    (e.parallel ? par : seq).push(r.latencySeconds);
  }
  const rootRow = root ? byLabel.get(root.label) : undefined;
  const latency = (rootRow?.latencySeconds ?? 0) + seq.reduce((a, b) => a + b, 0) + (par.length ? Math.max(...par) : 0);

  const subAgents = spec.nodes.filter(n => n.type === 'subagent').length;
  const modelCalls = rows.reduce((a, r) => a + r.calls, 0);

  let within = true;
  if (targets.costUsd != null && warmUsd > targets.costUsd) within = false;
  if (targets.latencySeconds != null && latency > targets.latencySeconds) within = false;

  // The optimisation levers, in order of impact, when over budget.
  const levers: string[] = [];
  if (!within) {
    if (subAgents > 0 && modelCalls / Math.max(subAgents, 1) > 2) {
      levers.push('collapse sub-agents that are not forced — each one adds a full call');
    }
    const heavy = rows.filter(r => r.policy !== 'isolated' && r.node !== root?.label);
    if (heavy.length) levers.push(`tighten context on: ${heavy.map(r => r.node).join(', ')}`);
    const big = rows.filter(r => r.tier === 'large' && r.calls <= 2);
    if (big.length) levers.push(`drop to a cheaper tier: ${big.map(r => r.node).join(', ')}`);
    const loud = rows.filter(r => r.outTokens > 600);
    if (loud.length) levers.push(`cap reply length on: ${loud.map(r => r.node).join(', ')}`);
    levers.push('mark independent sub-agent edges parallel to cut latency');
  }

  return {
    rows: rows.sort((a, b) => b.warmUsd - a.warmUsd),
    subAgents,
    modelCallsPerRun: modelCalls,
    coldUsd,
    warmUsd,
    cacheSavingPct: coldUsd > 0 ? Math.round((1 - warmUsd / coldUsd) * 100) : 0,
    latencySeconds: Math.round(latency * 10) / 10,
    withinBudget: within,
    levers,
  };
}

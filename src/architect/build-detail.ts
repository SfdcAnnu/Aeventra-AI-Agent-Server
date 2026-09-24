/**
 * Everything a build has produced so far, in the shape the chat's build
 * workspace draws: the requirement's capabilities and open questions, the
 * org survey in outline, the match with its gaps, the design laid out as
 * canvas nodes and wires WITHOUT saving it, the instructions per node, the
 * reviewer's verdict, the setup list, and the saved agent.
 *
 * Read from the checkpoint only — nothing here runs a stage or touches
 * the org. The preview mirrors the compiler's node mapping (types, sub
 * types, names) but not its org lookups, so it is free and instant; the
 * compiled agent may differ in the exact model id, never in shape.
 */
import type { BuildJob } from './build-job';
import type { AgentSpec, SpecNode, SpecPrerequisite } from './spec';

export interface PreviewNode {
  id: string;
  name: string;
  nodeType: 'ai' | 'subagent' | 'tool' | 'catalog';
  nodeSubType: string;
  config: Record<string, unknown>;
  positionX: number;
  positionY: number;
}
export interface PreviewConnection { id: string; fromNodeId: string; fromPort: 'tool'; toNodeId: string; toPort: 'in' }

/** The design as the builder will draw it. Positions come from the spec
 *  when the designer gave them; otherwise a layered layout — root left,
 *  specialists in the middle, tools beside whatever owns them. */
export function previewSpec(spec: AgentSpec): { nodes: PreviewNode[]; connections: PreviewConnection[] } {
  const owner = new Map<string, string>();
  for (const e of spec.edges) if (!owner.has(e.to)) owner.set(e.to, e.from);
  const root = spec.nodes.find(n => n.type === 'agent');
  const subs = spec.nodes.filter(n => n.type === 'subagent');
  const leaves = spec.nodes.filter(n => n.type === 'tool' || n.type === 'tool_catalog');
  const COL = [60, 380, 700];
  const ROW = 96;
  const pos = new Map<string, { x: number; y: number }>();
  // Tools under the root sit in column 2 above the specialists' tools.
  const rootTools = leaves.filter(t => !root || owner.get(t.id) === root.id || !owner.has(t.id));
  let y = 40;
  rootTools.forEach(t => { pos.set(t.id, { x: COL[1], y }); y += ROW * 0.8; });
  const subStartY = y + 20;
  let sy = subStartY;
  for (const s of subs) {
    const mine = leaves.filter(t => owner.get(t.id) === s.id);
    const blockH = Math.max(ROW, mine.length * ROW * 0.8);
    pos.set(s.id, { x: COL[1], y: sy + Math.max(0, (blockH - ROW) / 2) });
    mine.forEach((t, i) => pos.set(t.id, { x: COL[2], y: sy + i * ROW * 0.8 }));
    sy += blockH + 24;
  }
  const totalH = Math.max(sy, y);
  if (root) pos.set(root.id, { x: COL[0], y: Math.max(40, totalH / 2 - 40) });

  const nodes: PreviewNode[] = spec.nodes
    .filter(n => ['agent', 'subagent', 'tool', 'tool_catalog'].includes(n.type))
    .map((n): PreviewNode => {
      const p = n.position ?? pos.get(n.id) ?? { x: 60, y: 60 };
      const base = { id: n.id, name: n.label, positionX: p.x, positionY: p.y };
      if (n.type === 'agent') return { ...base, nodeType: 'ai', nodeSubType: engineOf(n), config: { model: n.model?.tier ?? 'medium', systemPrompt: n.instructions ?? '', thinkingEffort: n.model?.effort ?? 'standard', preview: true } };
      if (n.type === 'subagent') {
        const e = spec.edges.find(x => x.to === n.id);
        return { ...base, nodeType: 'subagent', nodeSubType: engineOf(n), config: { routingDescription: n.description ?? '', systemPrompt: n.instructions ?? '', mode: e?.mode === 'handoff' ? 'transfer' : 'call', contextPolicy: e?.contextPolicy ?? 'isolated', preview: true } };
      }
      if (n.type === 'tool_catalog') return { ...base, nodeType: 'catalog', nodeSubType: 'mcp', config: { description: n.description ?? '', provider: n.action?.connector ?? 'Salesforce Platform', preview: true } };
      const a = n.action;
      const actionType = a?.kind === 'apex_invocable' ? 'Apex' : a?.kind === 'flow_invocable' ? 'Flow' : 'MCP';
      return { ...base, nodeType: 'tool', nodeSubType: actionType.toLowerCase(), config: { description: n.description ?? '', actionType, toolName: a?.toolName ?? (a?.operation ? `${a.operation} ${a.sobject ?? ''}`.trim() : ''), requiresApproval: n.approval?.required === true, sobject: a?.sobject, operation: a?.operation, preview: true } };
    });
  const ids = new Set(nodes.map(n => n.id));
  const connections: PreviewConnection[] = spec.edges
    .filter(e => ids.has(e.from) && ids.has(e.to))
    .map(e => ({ id: `e${e.from}:tool-${e.to}:in`, fromNodeId: e.from, fromPort: 'tool', toNodeId: e.to, toPort: 'in' }));
  return { nodes, connections };
}

function engineOf(n: SpecNode): string {
  const p = (n.model?.modelId ?? '').toLowerCase();
  if (p.startsWith('claude')) return 'claude';
  if (p.startsWith('gemini')) return 'gemini';
  return 'gpt4';
}

const asStr = (v: unknown, max = 400): string => (v == null ? '' : String(v).slice(0, max));

/** One gap the match stage found, in the words the card shows. The
 *  matcher's items are free-form records; the common keys are read. */
function gapOf(item: Record<string, unknown>, state: 'partial' | 'missing'): Record<string, unknown> {
  return {
    state,
    capability: asStr(item.capability ?? item.name ?? item.title ?? item.requirement, 160),
    why: asStr(item.reason ?? item.why ?? item.gap ?? item.detail ?? item.description ?? item.note, 400),
    have: asStr(item.existing ?? item.have ?? item.matchedTo ?? item.match, 200),
    need: asStr(item.needs ?? item.need ?? item.missing ?? item.suggestion ?? item.fix, 300),
  };
}

export function buildDetail(job: BuildJob): Record<string, unknown> {
  const cp = job.checkpoint ?? {};
  const req = cp.requirement as { goal?: string; capabilities?: string[]; openQuestions?: string[]; successCriteria?: string[]; riskLevel?: string; trigger?: string; agentType?: string; clarifications?: string[] } | undefined;
  const surveyed = cp.surveyed as Record<string, unknown> | undefined;
  const match = cp.match as { matched?: Array<Record<string, unknown>>; partial?: Array<Record<string, unknown>>; missing?: Array<Record<string, unknown>>; coverage?: number } | undefined;
  const spec = cp.spec as AgentSpec | undefined;
  const review = cp.review;
  const prerequisites = (cp.prerequisites ?? spec?.prerequisites ?? []) as SpecPrerequisite[];
  return {
    jobId: job.id,
    status: job.status,
    stoppedAfter: job.stopAfter ?? null,
    requirement: req ? {
      goal: asStr(req.goal, 600),
      capabilities: (req.capabilities ?? []).map(c => asStr(c, 160)),
      openQuestions: (req.openQuestions ?? []).map(q => asStr(q, 300)),
      successCriteria: (req.successCriteria ?? []).map(q => asStr(q, 200)),
      riskLevel: req.riskLevel ?? null,
      trigger: asStr(req.trigger, 120) || null,
      agentType: req.agentType ?? 'communication',
      clarifications: (req.clarifications ?? []).map(c => asStr(c, 600)),
    } : null,
    survey: surveyed ? surveyOutline(surveyed) : null,
    match: match ? {
      coverage: match.coverage ?? null,
      matched: (match.matched ?? []).map(m => asStr(m.capability ?? m.name ?? m.title, 160)).filter(Boolean),
      gaps: [...(match.partial ?? []).map(m => gapOf(m, 'partial')), ...(match.missing ?? []).map(m => gapOf(m, 'missing'))],
    } : null,
    design: spec ? {
      name: spec.name,
      department: spec.department,
      description: spec.description ?? null,
      trigger: spec.trigger,
      preview: previewSpec(spec),
      counts: {
        specialists: spec.nodes.filter(n => n.type === 'subagent').length,
        tools: spec.nodes.filter(n => n.type === 'tool' || n.type === 'tool_catalog').length,
        approvals: spec.nodes.filter(n => n.type === 'tool' && n.approval?.required).length,
      },
      instructions: spec.nodes.filter(n => n.type === 'agent' || n.type === 'subagent').map(n => ({ id: n.id, label: n.label, role: n.type, text: asStr(n.instructions, 6000) })),
      guardrails: spec.guardrails ?? [],
      budgets: spec.budgets,
    } : null,
    review: review ?? null,
    prerequisites,
    result: job.result ?? null,
    error: job.error ?? null,
  };
}

/** The survey is a large free-form record; the card shows what was
 *  looked at, not the describes themselves. */
function surveyOutline(s: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (Array.isArray(v)) out[k] = { count: v.length, sample: v.slice(0, 12).map(x => (x && typeof x === 'object' ? asStr((x as Record<string, unknown>).name ?? (x as Record<string, unknown>).apiName ?? (x as Record<string, unknown>).label ?? JSON.stringify(x), 60) : asStr(x, 60))) };
    else if (v && typeof v === 'object') out[k] = { keys: Object.keys(v as object).slice(0, 12) };
    else out[k] = asStr(v, 120);
  }
  return out;
}

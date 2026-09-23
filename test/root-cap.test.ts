import { describe, it, expect } from 'vitest';
import { validateSpecLogic } from '../src/architect/spec';
import type { AgentSpec } from '../src/architect/spec';

/**
 * TWO RULES, TWO SCOPES, SO THEY CANNOT ARGUE.
 *
 * The split test asks, per capability, whether a sub-agent earned its
 * place. Nothing asked whether the agent LEFT BEHIND could carry what it
 * was given — so a designer told only that splitting needs evidence can
 * avoid the work by never splitting, and land every capability on one
 * node whose tools are re-sent on every turn.
 *
 * Real numbers from the org this was written against: agents the designer
 * built top out at 9 tools. The two that carry 26 and 46 are seeded
 * platform agents, which never reach validateSpec at all — syncSystemAgent
 * takes a different type. The cap is 15, which is headroom over the former
 * and irrelevant to the latter.
 */
const node = (id: string, type: string, label = id) => ({ id, type, label });

const spec = (toolCount: number, onNode = 'root'): AgentSpec => {
  const tools = Array.from({ length: toolCount }, (_, i) => node(`t${i}`, 'tool', `Tool ${i}`));
  return {
    specVersion: '1.0',
    trigger: { type: 'inbound_message' },
    nodes: [node('root', 'agent', 'Root'), node('helper', 'subagent', 'Helper'), ...tools],
    edges: [
      { from: 'root', to: 'helper', mode: 'call' },
      ...tools.map(t => ({ from: onNode, to: t.id, mode: 'static' })),
    ],
    architecture: {
      subAgentCount: 1,
      splitRationale: [
        { question: 'context', answer: true, evidence: 'a 1,500 line describe the root must not keep' },
        { question: 'permission', answer: false, evidence: 'same integration user throughout' },
        { question: 'independence', answer: false, evidence: 'needs the transcript' },
        { question: 'toolCount', answer: false, evidence: '4 tools on the root' },
      ],
    },
  } as unknown as AgentSpec;
};

const capErrors = (s: AgentSpec) => validateSpecLogic(s).filter(e => e.message.includes('the limit is'));

describe('a single agent node has a tool ceiling', () => {
  it('accepts a design at the limit', () => {
    expect(capErrors(spec(15))).toHaveLength(0);
  });

  it('rejects one over it', () => {
    const errs = capErrors(spec(16));
    expect(errs).toHaveLength(1);
    expect(errs[0].path).toBe('/nodes/root');
    expect(errs[0].message).toContain('carries 16 tools');
  });

  it('tells the designer what to do instead of only saying no', () => {
    const [err] = capErrors(spec(20));
    expect(err.message).toContain('sub-agent');
    expect(err.message).toContain('one line describing');
  });

  it('names some of the tools, so the group to move is visible', () => {
    const [err] = capErrors(spec(20));
    expect(err.message).toContain('Tool 0');
  });

  it('applies to a SUB-AGENT too — it is per node, not per root', () => {
    // A designer could otherwise satisfy the cap by moving everything onto
    // one overloaded specialist.
    const errs = capErrors(spec(16, 'helper'));
    expect(errs).toHaveLength(1);
    expect(errs[0].path).toBe('/nodes/helper');
  });

  it('counts only what is attached to THAT node', () => {
    // 10 on the root and 10 on the helper is 20 tools and no breach.
    const s = spec(10);
    const extra = Array.from({ length: 10 }, (_, i) => node(`h${i}`, 'tool', `Helper tool ${i}`));
    s.nodes.push(...extra);
    s.edges.push(...extra.map(t => ({ from: 'helper', to: t.id, mode: 'static' })) as never);
    expect(capErrors(s)).toHaveLength(0);
  });

  it('leaves the split test alone — the two rules do not collide', () => {
    // A design that breaches the cap still passes the split test, and vice
    // versa. One proposes, the other disposes.
    const errs = validateSpecLogic(spec(16));
    expect(errs.some(e => e.message.includes('forcing question'))).toBe(false);
  });
});

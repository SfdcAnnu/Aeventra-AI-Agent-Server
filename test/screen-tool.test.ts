/**
 * show_on_screen is a result the client acts on: it names a view and, for
 * usage and cost, carries the per-agent rows so the screen and the words
 * agree. The handler's only logic is here, in screenPayload.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_TOOLS, screenPayload } from '../src/platform/agent-tools';
import { archonCopilotAgent } from '../src/platform/agents/archon-copilot';

const stats = {
  days: 31,
  byAgent: [
    { apiName: 'whatsapp_lead_intake_qualifier', name: 'WhatsApp Lead Intake Qualifier', turns: 173, tokensIn: 984_403, tokensOut: 61_200 },
    { apiName: 'archon_copilot', name: 'Archon Copilot', turns: 58, tokensIn: 203_576, tokensOut: 18_400 },
    { apiName: null, name: null, turns: 3, tokensIn: 900, tokensOut: 100 },
  ],
};

describe('screenPayload', () => {
  it('names the view and nothing else when no rows are wanted', () => {
    expect(screenPayload('dashboard', undefined, undefined, null)).toEqual({ screen: { view: 'dashboard', days: null, agentApiName: null } });
  });
  it('carries the usage rows, largest first, without sessions that have no agent', () => {
    const p = screenPayload('usage', 31, undefined, stats);
    expect(p.screen).toEqual({ view: 'usage', days: 31, agentApiName: null });
    expect(p.usage?.byAgent.map(r => r.apiName)).toEqual(['whatsapp_lead_intake_qualifier', 'archon_copilot']);
    expect(p.usage?.turns).toBe(231);
    expect(p.usage?.tokensIn).toBe(984_403 + 203_576);
  });
  it('narrows to one agent when asked', () => {
    const p = screenPayload('cost', 7, 'archon_copilot', stats);
    expect(p.usage?.byAgent).toHaveLength(1);
    expect(p.usage?.byAgent[0].name).toBe('Archon Copilot');
  });
});

describe('the copilot can reach the screen', () => {
  it('registers show_on_screen as a read-only platform tool', () => {
    const t = AGENT_TOOLS.find(x => x.name === 'show_on_screen');
    expect(t?.readOnly).toBe(true);
  });
  it('gives the root the tool and tells it where it is', () => {
    expect(archonCopilotAgent.root.tools.some(t => t.toolName === 'show_on_screen')).toBe(true);
    expect(archonCopilotAgent.root.instructions).toMatch(/ARCHON SCREEN/);
    expect(archonCopilotAgent.version).toBeGreaterThanOrEqual(13);
  });
});

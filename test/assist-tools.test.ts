import { describe, it, expect } from 'vitest';
import { PAGES, pageLink, blockersOf, pingServers } from '../src/platform/assist-tools';
import { archonCopilotAgent } from '../src/platform/agents/archon-copilot';
import { PLATFORM_TOOLS } from '../src/platform/tools';

/**
 * The everyday tools that let the copilot act like a colleague: a page the
 * person can open, servers woken on request, activation that states the
 * trade-off once, and a way back from a handover.
 */
describe('open_page', () => {
  it('links every page to its route, and an agent to its canvas', () => {
    expect(pageLink('connectors')).toEqual({ path: '/connectors', label: 'Connectors' });
    expect(pageLink('runs')?.path).toBe('/executions');
    expect(pageLink('agent', 'deal_risk scorer')?.path).toBe('/agent/deal_risk%20scorer');
    expect(pageLink('agent')).toBeNull();
    expect(Object.keys(PAGES)).toContain('ai_models');
  });
});

describe('activate_agent blockers', () => {
  it('counts only open blocking setup items and the nodes a build switched off', () => {
    const checklist = JSON.stringify([
      { title: 'Connect Gmail', blocking: true, status: 'pending' },
      { title: 'Manager emails filled', blocking: false, status: 'pending' },
      { title: 'Description field', blocking: true, status: 'done' },
    ]);
    const nodes = [
      { Name: 'Run SOQL', IsEnabled__c: false, ConfigJson__c: '{"blockedByPrerequisite":"PRE-003"}' },
      { Name: 'Turned off by hand', IsEnabled__c: false, ConfigJson__c: '{}' },
      { Name: 'Create Task', IsEnabled__c: true, ConfigJson__c: '{}' },
    ];
    expect(blockersOf(checklist, nodes)).toEqual({ setup: ['Connect Gmail'], switchedOff: ['Run SOQL'] });
    expect(blockersOf('not json', [])).toEqual({ setup: [], switchedOff: [] });
  });
});

describe('wake_servers', () => {
  it('treats any answer as awake, a slow one as woken, and a timeout as no answer', async () => {
    const fake = (async (url: string) => {
      if (url.includes('slow')) { await new Promise(r => setTimeout(r, 30)); return new Response('', { status: 404 }); }
      if (url.includes('dead')) throw new Error('timeout');
      return new Response('ok');
    }) as unknown as typeof fetch;
    const out = await pingServers([
      { key: 'a', name: 'CRM', url: 'https://fast.example.com/mcp' },
      { key: 'b', name: 'Gmail', url: 'https://slow.example.com' },
      { key: 'c', name: 'Outlook', url: 'https://dead.example.com' },
    ], fake);
    expect(out.map(o => o.state)).toEqual(['awake', 'awake', 'no_answer']);
  });
});

describe('copilot version 16', () => {
  it('gives the root the everyday tools, all of which the platform serves', () => {
    const names = archonCopilotAgent.root.tools.map(t => t.toolName);
    for (const t of ['open_page', 'wake_servers', 'activate_agent', 'show_on_screen', 'transfer_to_agent']) expect(names).toContain(t);
    const served = new Set(PLATFORM_TOOLS.map(t => t.name));
    for (const t of names) expect(served.has(t)).toBe(true);
    expect(served.has('return_to_previous_agent')).toBe(true);
    expect(archonCopilotAgent.version).toBe(16);
  });

  it('talks like a person and knows the screen\'s own messages', () => {
    const ins = archonCopilotAgent.root.instructions;
    expect(ins).toMatch(/HOW YOU TALK/);
    expect(ins).toMatch(/\[Update\]/);
    expect(ins).toMatch(/\[Back from <agent>\]/);
    expect(ins).not.toMatch(/NOTHING RUNS BETWEEN TURNS/);
  });
});

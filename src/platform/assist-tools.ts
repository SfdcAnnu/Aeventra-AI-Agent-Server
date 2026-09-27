/**
 * The everyday tools an assistant needs so it can act like a colleague
 * rather than a router: open a page for the person, wake the servers that
 * sleep, activate an agent when asked (and say plainly what will not work
 * yet), and hand a conversation back to the agent that passed it over.
 *
 * Like transfer_to_agent and show_on_screen, a page and a return are
 * RESULTS the chat UI acts on; the server does no navigation.
 */
import { z } from 'zod';
import { AgentCache } from '../chat/agent-cache';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { pkgConn } from '../salesforce/namespace';
import { logger } from '../logger';
import { define, ok, fail } from './tool-kit';

// ── open_page ────────────────────────────────────────────────────────

/** The app's pages, by what a person calls them. Paths match routes.tsx. */
export const PAGES = {
  home: { path: '/home', label: 'Home' },
  agents: { path: '/', label: 'Agents' },
  agent: { path: '/agent/:apiName', label: 'the agent on the canvas' },
  new_agent: { path: '/new-agent', label: 'New agent' },
  connectors: { path: '/connectors', label: 'Connectors' },
  approvals: { path: '/approvals', label: 'Approvals' },
  runs: { path: '/executions', label: 'Runs' },
  conversations: { path: '/conversations', label: 'Conversations' },
  cost: { path: '/cost', label: 'Cost' },
  knowledge: { path: '/knowledge', label: 'Knowledge' },
  ai_models: { path: '/ai-connections', label: 'AI Models' },
  templates: { path: '/templates', label: 'Templates' },
  setup: { path: '/setup', label: 'Setup' },
  settings: { path: '/settings', label: 'Settings' },
  environments: { path: '/environments', label: 'Environments' },
} as const;
export type PageKey = keyof typeof PAGES;

/** Where a page lives, with the agent filled in for the canvas. */
export function pageLink(page: PageKey, agentApiName?: string | null): { path: string; label: string } | null {
  const p = PAGES[page];
  if (page === 'agent') {
    if (!agentApiName) return null;
    return { path: `/agent/${encodeURIComponent(agentApiName)}`, label: `${agentApiName} on the canvas` };
  }
  return { path: p.path, label: p.label };
}

const openPage = define({
  name: 'open_page',
  title: 'Open a page',
  description:
    'Give the person a one-click way to a page of this app: home, agents (the list), agent (one agent on the canvas — needs agentApiName), ' +
    'new_agent, connectors, approvals, runs, conversations, cost, knowledge, ai_models, templates, setup, settings, environments. ' +
    'The chat shows an Open button; it never navigates by itself, so the conversation is not lost.',
  inputSchema: {
    page: z.enum(Object.keys(PAGES) as [PageKey, ...PageKey[]]),
    agentApiName: z.string().max(120).optional().describe('For page "agent": the agent to open on the canvas'),
  },
  readOnly: true,
  handler: async ({ page, agentApiName }) => {
    const link = pageLink(page, agentApiName ?? null);
    if (!link) return fail('page "agent" needs agentApiName — call list_agents to find it.');
    return ok({ page: link }, `PAGE ${link.label}: ${link.path}`);
  },
});

// ── wake_servers ─────────────────────────────────────────────────────

export interface WakeResult { key: string; name: string; state: 'awake' | 'woke' | 'no_answer'; seconds: number }

/**
 * Ask every connector server for any response at all. A free-plan server
 * that is asleep takes 20–60 s to boot; any HTTP answer (a 404 from a
 * server with no health page included) means the process is up.
 */
export async function pingServers(
  servers: Array<{ key: string; name: string; url: string }>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 150_000,
): Promise<WakeResult[]> {
  return Promise.all(servers.map(async s => {
    const started = Date.now();
    const base = s.url.replace(/\/+$/, '').replace(/\/mcp$/, '');
    try {
      await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      return { key: s.key, name: s.name, state: seconds >= 8 ? 'woke' : 'awake', seconds };
    } catch {
      return { key: s.key, name: s.name, state: 'no_answer', seconds: Math.round((Date.now() - started) / 1000) };
    }
  }));
}

const wakeServers = define({
  name: 'wake_servers',
  title: 'Wake the servers',
  description:
    'Wake every connector server (Salesforce CRM, Salesforce Metadata, Gmail, Outlook, and any other with a URL) in parallel and report each: ' +
    'already awake, woke up (with how long it took), or no answer. Use it when the person asks to open, start, enable or wake the servers, ' +
    'or when a tool failed because a server was asleep. Takes up to about a minute.',
  inputSchema: {},
  readOnly: true,
  handler: async (_args, p) => {
    const conn = pkgConn(await getOrgConnection(p.orgId));
    const res = await conn.query<{ DeveloperName: string; MasterLabel?: string; DisplayName__c?: string; McpServerUrl__c?: string }>(
      'SELECT DeveloperName, MasterLabel, DisplayName__c, McpServerUrl__c FROM ConnectorCatalog__mdt',
    );
    const servers = res.records
      .filter(r => r.McpServerUrl__c)
      .map(r => ({ key: r.DeveloperName, name: r.DisplayName__c || r.MasterLabel || r.DeveloperName, url: r.McpServerUrl__c! }));
    if (servers.length === 0) return fail('No connector has a server URL yet.');
    const results = await pingServers(servers);
    logger.info({ orgId: p.orgId, results }, 'platform_wake_servers');
    const line = results.map(r => `${r.name}: ${r.state === 'no_answer' ? 'no answer' : r.state === 'woke' ? `woke in ${r.seconds}s` : 'already awake'}`).join('; ');
    return ok({ servers: results, note: 'Free-plan servers sleep again after about 15 minutes without traffic.' }, line);
  },
});

// ── activate_agent ───────────────────────────────────────────────────

interface ChecklistItem { title?: string; blocking?: boolean; status?: string }

/** What still stands in an agent's way: open blocking setup items, and
 *  nodes the build switched off because of them. */
export function blockersOf(checklistJson: string | null | undefined, nodes: Array<{ Name: string; IsEnabled__c: boolean; ConfigJson__c?: string | null }>): { setup: string[]; switchedOff: string[] } {
  let items: ChecklistItem[] = [];
  try { items = JSON.parse(checklistJson || '[]'); } catch { items = []; }
  const setup = (Array.isArray(items) ? items : [])
    .filter(i => i && i.blocking && i.status !== 'done' && i.status !== 'waived')
    .map(i => String(i.title ?? 'a setup step'));
  const switchedOff = nodes
    .filter(n => !n.IsEnabled__c && /blockedByPrerequisite/.test(n.ConfigJson__c ?? ''))
    .map(n => n.Name);
  return { setup, switchedOff };
}

const activateAgent = define({
  name: 'activate_agent',
  title: 'Activate an agent',
  description:
    'Set an agent Active, only when the person asks for it. If setup is still open it does NOT activate on the first call: it returns what is open ' +
    'and which nodes are switched off, so you can tell the person in one or two lines what will not work yet. When they still want it live, ' +
    'call again with anyway=true. Deactivate with active=false.',
  inputSchema: {
    apiName: z.string().min(1).max(120),
    anyway: z.boolean().default(false).describe('Activate even though setup items are open — only after the person said so'),
    active: z.boolean().default(true).describe('false sets the agent Inactive'),
  },
  readOnly: false,
  handler: async ({ apiName, anyway, active }, p) => {
    const conn = pkgConn(await getOrgConnection(p.orgId));
    const q = apiName.replace(/'/g, "\\'");
    const defs = await conn.query<{ Id: string; Name: string; Status__c: string; SetupChecklistJson__c?: string }>(
      `SELECT Id, Name, Status__c, SetupChecklistJson__c FROM AgentDefinition__c WHERE ApiName__c = '${q}' LIMIT 1`,
    );
    const def = defs.records[0];
    if (!def) return fail(`No agent with API name ${apiName} — call list_agents first.`);
    if (apiName === 'archon_copilot') return fail('The copilot is managed by the platform; switch it on or off from Setup.');
    const target = active ? 'Active' : 'Inactive';
    if (def.Status__c === target) return ok({ apiName, name: def.Name, status: target, changed: false }, `${def.Name} is already ${target}.`);

    if (active) {
      const nodes = await conn.query<{ Name: string; IsEnabled__c: boolean; ConfigJson__c?: string }>(
        `SELECT Name, IsEnabled__c, ConfigJson__c FROM AgentNode__c WHERE AgentDefinition__c = '${def.Id}'`,
      );
      const b = blockersOf(def.SetupChecklistJson__c, nodes.records);
      if ((b.setup.length || b.switchedOff.length) && !anyway) {
        return ok(
          { apiName, name: def.Name, status: def.Status__c, changed: false, needsConfirmation: true, openSetup: b.setup, switchedOffNodes: b.switchedOff },
          `NOT ACTIVATED YET — ${def.Name} has ${b.setup.length} open setup item(s)` +
            (b.switchedOff.length ? ` and ${b.switchedOff.length} switched-off node(s): ${b.switchedOff.join(', ')}` : '') +
            '. Tell the person what will not work, and call again with anyway=true if they still want it live.',
        );
      }
    }
    await conn.sobject('AgentDefinition__c').update({ Id: def.Id, Status__c: target });
    AgentCache.invalidate(p.orgId, apiName);
    logger.info({ orgId: p.orgId, apiName, target, anyway }, 'platform_agent_status_set');
    return ok({ apiName, name: def.Name, status: target, changed: true }, `${def.Name} is now ${target}.`);
  },
});

// ── return_to_previous_agent ─────────────────────────────────────────

const returnToPrevious = define({
  name: 'return_to_previous_agent',
  title: 'Hand back to the previous agent',
  description:
    'When this conversation was handed to you by another agent (Archon) and the job you were given is finished — or the person wants to go back — ' +
    'hand it back. Give a short summary of what was done and anything still open; the previous agent picks up its task from there.',
  inputSchema: {
    summary: z.string().min(1).max(1500).describe('What you did, what was created or changed, and anything still open'),
  },
  readOnly: true,
  handler: async ({ summary }) => ok({ returnTo: { summary } }, `RETURN: ${summary}`),
});

export const ASSIST_TOOLS = [openPage, wakeServers, activateAgent, returnToPrevious];

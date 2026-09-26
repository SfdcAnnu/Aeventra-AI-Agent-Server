/**
 * Inspector tools — read-only views of what is happening on the platform,
 * as MCP tools: the Home numbers, runs, conversations, approvals,
 * connectors. Each is a thin query the same pages already make; they
 * exist so an agent can answer "what failed today?" with the real figure.
 *
 * Every query is scoped by the org the principal's token carries. Nothing
 * here writes.
 */
import { z } from 'zod';
import type { Connection } from 'jsforce';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { ChatApprovalsRepo } from '../db/chat-approvals.repo';
import { logger } from '../logger';
import { define, ok, fail, clip } from './tool-kit';

const FAILED = new Set(['ERROR', 'TIMEOUT']);

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** The same aggregate the Home page's Apex builds, from Node: per day and
 *  per agent across runs AND chat turns. TurnStatus__c may not exist in an
 *  org yet — the query degrades to "all turns ok" rather than failing. */
export async function homeStats(conn: Connection, days: number) {
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);
  const startIso = start.toISOString();
  const byDay = new Map<string, { day: string; runsOk: number; runsFailed: number; runsOther: number; turnsOk: number; turnsFailed: number }>();
  for (let i = 0; i < days; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    byDay.set(key, { day: key, runsOk: 0, runsFailed: 0, runsOther: 0, turnsOk: 0, turnsFailed: 0 });
  }
  const runs = await conn.query<{ d: string; st: string; c: number }>(
    `SELECT DAY_ONLY(CreatedDate) d, Status__c st, COUNT(Id) c FROM AgentExecution__c WHERE CreatedDate >= ${startIso} GROUP BY DAY_ONLY(CreatedDate), Status__c`,
  );
  for (const r of runs.records) {
    const b = byDay.get(String(r.d)); if (!b) continue;
    if (r.st === 'SUCCESS') b.runsOk += r.c; else if (FAILED.has(r.st)) b.runsFailed += r.c; else b.runsOther += r.c;
  }
  let turnsQ;
  try {
    turnsQ = await conn.query<{ d: string; st: string | null; c: number }>(
      `SELECT DAY_ONLY(CreatedDate) d, TurnStatus__c st, COUNT(Id) c FROM ChatMessage__c WHERE Role__c = 'Assistant' AND CreatedDate >= ${startIso} GROUP BY DAY_ONLY(CreatedDate), TurnStatus__c`,
    );
  } catch {
    turnsQ = await conn.query<{ d: string; st: string | null; c: number }>(
      `SELECT DAY_ONLY(CreatedDate) d, COUNT(Id) c FROM ChatMessage__c WHERE Role__c = 'Assistant' AND CreatedDate >= ${startIso} GROUP BY DAY_ONLY(CreatedDate)`,
    );
  }
  for (const r of turnsQ.records) {
    const b = byDay.get(String(r.d)); if (!b) continue;
    if (r.st === 'Failed') b.turnsFailed += r.c; else b.turnsOk += r.c;
  }
  const agents = await conn.query<{ a: string; n: string; ti: number | null; tout: number | null; c: number }>(
    `SELECT ChatSession__r.AgentDefinition__r.ApiName__c a, ChatSession__r.AgentDefinition__r.Name n, SUM(TokensIn__c) ti, SUM(TokensOut__c) tout, COUNT(Id) c FROM ChatMessage__c WHERE Role__c = 'Assistant' AND CreatedDate >= ${startIso} GROUP BY ChatSession__r.AgentDefinition__r.ApiName__c, ChatSession__r.AgentDefinition__r.Name`,
  );
  const dayList = [...byDay.values()];
  return {
    days,
    byDay: dayList,
    runs: dayList.reduce((s, d) => s + d.runsOk + d.runsFailed + d.runsOther, 0),
    runsFailed: dayList.reduce((s, d) => s + d.runsFailed, 0),
    turns: dayList.reduce((s, d) => s + d.turnsOk + d.turnsFailed, 0),
    turnsFailed: dayList.reduce((s, d) => s + d.turnsFailed, 0),
    tokensIn: agents.records.reduce((s, r) => s + (r.ti ?? 0), 0),
    tokensOut: agents.records.reduce((s, r) => s + (r.tout ?? 0), 0),
    byAgent: agents.records.map(r => ({ apiName: r.a, name: r.n, turns: r.c, tokensIn: r.ti ?? 0, tokensOut: r.tout ?? 0 })),
  };
}

const stats = define({
  name: 'home_stats',
  title: 'Platform activity',
  description: 'Activity on this platform for the last N days, org-wide: runs and chat turns per day with successes and failures, tokens, and the per-agent split. The same numbers the Home page shows.',
  inputSchema: { days: z.number().int().min(1).max(31).default(7) },
  readOnly: true,
  handler: async ({ days }, p) => ok(await homeStats(await getOrgConnection(p.orgId), days)),
});

const listRuns = define({
  name: 'list_runs',
  title: 'List runs',
  description: 'Recent automation runs (not chat): agent, status, duration, when. Filter by status: SUCCESS, ERROR, TIMEOUT, QUEUED, RUNNING, WAITING_APPROVAL.',
  inputSchema: { status: z.string().max(30).optional(), agentApiName: z.string().max(120).optional(), limit: z.number().int().min(1).max(50).default(20) },
  readOnly: true,
  handler: async ({ status, agentApiName, limit }, p) => {
    const conn = await getOrgConnection(p.orgId);
    const where = [status ? `Status__c = '${esc(status)}'` : '', agentApiName ? `AgentDefinition__r.ApiName__c = '${esc(agentApiName)}'` : ''].filter(Boolean);
    const r = await conn.query<Record<string, unknown>>(
      `SELECT Id, Name, AgentDefinition__r.Name, AgentDefinition__r.ApiName__c, Status__c, ExecutionMs__c, CorrelationId__c, AgentReason__c, CreatedDate FROM AgentExecution__c${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY CreatedDate DESC LIMIT ${limit}`,
    );
    return ok({ runs: r.records.map(x => ({ id: x.Id, name: x.Name, agent: (x.AgentDefinition__r as { Name?: string } | null)?.Name ?? null, agentApiName: (x.AgentDefinition__r as { ApiName__c?: string } | null)?.ApiName__c ?? null, status: x.Status__c, ms: x.ExecutionMs__c ?? null, correlationId: x.CorrelationId__c ?? null, reason: clip(x.AgentReason__c as string | null, 200), at: x.CreatedDate })) });
  },
});

const listConversations = define({
  name: 'list_conversations',
  title: 'List conversations',
  description: 'Recent chat sessions across the org: agent, title, status, turns, tokens, last activity.',
  inputSchema: { agentApiName: z.string().max(120).optional(), limit: z.number().int().min(1).max(50).default(20) },
  readOnly: true,
  handler: async ({ agentApiName, limit }, p) => {
    const conn = await getOrgConnection(p.orgId);
    const where = agentApiName ? ` WHERE AgentDefinition__r.ApiName__c = '${esc(agentApiName)}'` : '';
    const r = await conn.query<Record<string, unknown>>(
      `SELECT Id, Name, Title__c, Status__c, AgentDefinition__r.Name, AgentDefinition__r.ApiName__c, TotalTurns__c, TokensIn__c, TokensOut__c, LastActivityAt__c FROM ChatSession__c${where} ORDER BY LastActivityAt__c DESC NULLS LAST LIMIT ${limit}`,
    );
    return ok({ conversations: r.records.map(x => ({ id: x.Id, name: x.Name, title: x.Title__c ?? null, status: x.Status__c, agent: (x.AgentDefinition__r as { Name?: string } | null)?.Name ?? null, agentApiName: (x.AgentDefinition__r as { ApiName__c?: string } | null)?.ApiName__c ?? null, turns: x.TotalTurns__c ?? 0, tokensIn: x.TokensIn__c ?? 0, tokensOut: x.TokensOut__c ?? 0, lastActivityAt: x.LastActivityAt__c ?? null })) });
  },
});

const conversationDetail = define({
  name: 'conversation_detail',
  title: 'Conversation detail',
  description: 'The messages of one chat session in order — role, text (trimmed), model, tokens, whether the turn failed. For reading what happened, not for replaying.',
  inputSchema: { sessionId: z.string().min(15).max(18), limit: z.number().int().min(1).max(60).default(40) },
  readOnly: true,
  handler: async ({ sessionId, limit }, p) => {
    const conn = await getOrgConnection(p.orgId);
    const base = `FROM ChatMessage__c WHERE ChatSession__c = '${esc(sessionId)}' ORDER BY SequenceNumber__c ASC LIMIT ${limit}`;
    let r;
    try {
      r = await conn.query<Record<string, unknown>>(`SELECT Role__c, Content__c, ModelUsed__c, TokensIn__c, TokensOut__c, LatencyMs__c, TurnStatus__c, CreatedDate ${base}`);
    } catch {
      r = await conn.query<Record<string, unknown>>(`SELECT Role__c, Content__c, ModelUsed__c, TokensIn__c, TokensOut__c, LatencyMs__c, CreatedDate ${base}`);
    }
    return ok({ sessionId, messages: r.records.map(x => ({ role: x.Role__c, text: clip(x.Content__c as string | null, 500), model: x.ModelUsed__c ?? null, tokensIn: x.TokensIn__c ?? null, tokensOut: x.TokensOut__c ?? null, ms: x.LatencyMs__c ?? null, failed: x.TurnStatus__c === 'Failed', at: x.CreatedDate })) });
  },
});

const listApprovals = define({
  name: 'list_approvals',
  title: 'List approvals',
  description: 'Actions waiting for a human decision (or already decided): chat actions the runtime suspended, and run approvals. Nothing is written until someone approves.',
  inputSchema: { status: z.enum(['Pending', 'Approved', 'Rejected']).default('Pending'), limit: z.number().int().min(1).max(50).default(20) },
  readOnly: true,
  handler: async ({ status, limit }, p) => {
    const chat = await ChatApprovalsRepo.listForOrg(p.orgId, { status, limit }).catch(() => []);
    let runs: Array<Record<string, unknown>> = [];
    try {
      const conn = await getOrgConnection(p.orgId);
      const r = await conn.query<Record<string, unknown>>(`SELECT Id, Name, Status__c, CreatedDate FROM AgentApproval__c WHERE Status__c = '${esc(status)}' ORDER BY CreatedDate DESC LIMIT ${limit}`);
      runs = r.records.map(x => ({ id: x.Id, name: x.Name, status: x.Status__c, at: x.CreatedDate }));
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'list_approvals_run_approvals_unavailable');
    }
    return ok({ status, chatApprovals: (chat as Array<Record<string, unknown>>).map(a => ({ id: a.id, agent: a.agentApiName ?? a.agentName ?? null, tool: a.toolName ?? null, summary: clip(String(a.summary ?? a.description ?? ''), 200), createdAt: a.createdAt ?? null })), runApprovals: runs });
  },
});

const listConnectors = define({
  name: 'list_connectors',
  title: 'List connectors',
  description: 'The connectors this org can use: the packaged catalog (Salesforce, Gmail, Outlook, Salesforce Metadata, …) with their MCP server URL when they have one, plus any custom MCP servers an admin added.',
  inputSchema: {},
  readOnly: true,
  handler: async (_a, p) => {
    const conn = await getOrgConnection(p.orgId);
    const cat = await conn.query<Record<string, unknown>>('SELECT DeveloperName, DisplayName__c, Category__c, McpServerUrl__c, MapsToCatalogType__c FROM ConnectorCatalog__mdt ORDER BY SortOrder__c');
    let custom: Array<Record<string, unknown>> = [];
    try {
      const c = await conn.query<Record<string, unknown>>('SELECT Id, Name, McpServerUrl__c, Category__c, CatalogType__c FROM CustomMcpServer__c WHERE IsActive__c = true');
      custom = c.records.map(x => ({ provider: `custom_${x.Id}`, name: x.Name, url: x.McpServerUrl__c, category: x.Category__c, catalogType: x.CatalogType__c }));
    } catch { /* org without the custom-server object */ }
    return ok({ catalog: cat.records.map(x => ({ provider: x.DeveloperName, name: x.DisplayName__c, category: x.Category__c, url: x.McpServerUrl__c ?? null, catalogType: x.MapsToCatalogType__c })), custom });
  },
});

const connectorTools = define({
  name: 'connector_tools',
  title: 'Connector tools',
  description: 'The tool names a connector\'s MCP server publishes (its public GET /tools list). Use list_connectors for the provider keys.',
  inputSchema: { provider: z.string().min(1).max(120) },
  readOnly: true,
  handler: async ({ provider }, p) => {
    const conn = await getOrgConnection(p.orgId);
    let url: string | undefined;
    if (provider.startsWith('custom_')) {
      const r = await conn.query<{ McpServerUrl__c?: string }>(`SELECT McpServerUrl__c FROM CustomMcpServer__c WHERE Id = '${esc(provider.slice(7))}' LIMIT 1`);
      url = r.records[0]?.McpServerUrl__c;
    } else {
      const r = await conn.query<{ McpServerUrl__c?: string }>(`SELECT McpServerUrl__c FROM ConnectorCatalog__mdt WHERE DeveloperName = '${esc(provider)}' LIMIT 1`);
      url = r.records[0]?.McpServerUrl__c;
    }
    if (!url) return fail(`No MCP server URL for provider "${provider}".`);
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8_000);
      const res = await fetch(`${url.replace(/\/+$/, '')}/tools`, { signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) return fail(`${provider} answered ${res.status} for its tool list — it may be asleep or not expose /tools.`);
      const body = (await res.json()) as { tools?: Array<{ name: string; title?: string; description?: string }> };
      return ok({ provider, url, tools: (body.tools ?? []).map(t => ({ name: t.name, title: t.title ?? null, description: clip(t.description ?? null, 160) })) });
    } catch (err) {
      return fail(`Could not reach ${provider}: ${(err as Error).message}`);
    }
  },
});

export const INSPECTOR_TOOLS = [stats, listRuns, listConversations, conversationDetail, listApprovals, listConnectors, connectorTools];

/**
 * The Org Surveyor's toolset — read-only by construction. Describes,
 * inventories and live tool lists; never DML, never action invocation
 * (verifying a "send invoice" action by running it would send an invoice).
 *
 * Everything runs on the org's integration-user connection, so results are
 * permission-aware by definition: an object the user cannot query simply
 * does not describe as queryable, and a Flow they cannot run does not list.
 *
 * Also home of the LIVE capability manifest — the compile-time authority on
 * what tools exist. The schema's `action.discovered: true` promises a tool
 * was found; the manifest is what makes that promise checkable, at design
 * time AND again at compile time, because orgs change between the two.
 */
import { getOrgConnection } from '../salesforce/per-org-connection';
import { resolveProviderToken } from '../chat/adapters/shared';
import { listToolsCached } from '../mcp/tool-list-cache';
import { InstallsRepo } from '../db/installs.repo';
import { prisma } from '../db/client';
import { logger } from '../logger';
import { manifestFromNames, type CapabilityManifest } from './spec';

const SAFE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,80}$/;
const API_VERSION = '62.0';

// ── Objects ──────────────────────────────────────────────────────────
export interface ObjectSummary {
  name: string;
  label: string;
  custom: boolean;
  queryable: boolean;
  createable: boolean;
  updateable: boolean;
}

export async function listObjects(orgId: string, nameFilter?: string): Promise<ObjectSummary[]> {
  const conn = await getOrgConnection(orgId);
  const g = await conn.describeGlobal();
  const filter = nameFilter?.toLowerCase();
  return g.sobjects
    .filter(s => !s.deprecatedAndHidden)
    .filter(s => !filter || s.name.toLowerCase().includes(filter) || (s.label ?? '').toLowerCase().includes(filter))
    .map(s => ({
      name: s.name,
      label: s.label ?? s.name,
      custom: !!s.custom,
      queryable: !!s.queryable,
      createable: !!s.createable,
      updateable: !!s.updateable,
    }));
}

export interface FieldSummary {
  name: string;
  label: string;
  type: string;
  required: boolean;
  updateable: boolean;
  picklistValues?: string[];
}

export async function describeObjectCompact(orgId: string, objectName: string, maxFields = 80): Promise<{
  name: string;
  fields: FieldSummary[];
  totalFields: number;
}> {
  if (!SAFE_NAME_RE.test(objectName)) throw new Error(`Invalid object name "${objectName}".`);
  const conn = await getOrgConnection(orgId);
  const desc = await (conn.sobject(objectName) as unknown as {
    describe: () => Promise<{
      fields: Array<{
        name: string;
        label: string;
        type: string;
        nillable: boolean;
        updateable: boolean;
        picklistValues?: Array<{ value: string; active: boolean }>;
      }>;
    }>;
  }).describe();
  return {
    name: objectName,
    totalFields: desc.fields.length,
    fields: desc.fields.slice(0, maxFields).map(f => ({
      name: f.name,
      label: f.label,
      type: f.type,
      required: !f.nillable,
      updateable: f.updateable,
      ...(f.picklistValues?.length
        ? { picklistValues: f.picklistValues.filter(v => v.active).slice(0, 15).map(v => v.value) }
        : {}),
    })),
  };
}

// ── Invocable Apex and auto-launched Flows ───────────────────────────
export interface InvocableSummary {
  kind: 'apex' | 'flow';
  name: string;
  label: string;
}

export async function listInvocables(orgId: string): Promise<InvocableSummary[]> {
  const conn = await getOrgConnection(orgId);
  const out: InvocableSummary[] = [];
  for (const type of ['apex', 'flow'] as const) {
    try {
      const r = await conn.request<{ actions?: Array<{ name: string; label?: string }> }>(
        `/services/data/v${API_VERSION}/actions/custom/${type}`,
      );
      for (const a of (r?.actions ?? []).slice(0, 120)) {
        out.push({ kind: type, name: a.name, label: a.label ?? a.name });
      }
    } catch (err) {
      logger.warn({ orgId, type, err: err instanceof Error ? err.message : err }, 'surveyor_invocable_list_failed');
    }
  }
  return out;
}

/** The signature — inputs/outputs — of one invocable, on demand. */
export async function describeInvocable(
  orgId: string,
  kind: 'apex' | 'flow',
  name: string,
): Promise<{ inputs: Array<{ name: string; type: string; required: boolean }>; outputs: Array<{ name: string; type: string }> }> {
  if (!SAFE_NAME_RE.test(name)) throw new Error(`Invalid action name "${name}".`);
  const conn = await getOrgConnection(orgId);
  const r = await conn.request<{
    inputs?: Array<{ name: string; type?: string; required?: boolean }>;
    outputs?: Array<{ name: string; type?: string }>;
  }>(`/services/data/v${API_VERSION}/actions/custom/${kind}/${name}`);
  return {
    inputs: (r?.inputs ?? []).map(i => ({ name: i.name, type: i.type ?? 'string', required: !!i.required })),
    outputs: (r?.outputs ?? []).map(o => ({ name: o.name, type: o.type ?? 'string' })),
  };
}

// ── Live MCP tool lists ──────────────────────────────────────────────
export interface McpToolInventory {
  provider: string;
  url: string;
  tools: Array<{ name: string; description: string }>;
  error?: string;
}

export async function listMcpToolsLive(orgId: string): Promise<McpToolInventory[]> {
  const conn = await getOrgConnection(orgId);
  const install = await InstallsRepo.findByOrgId(orgId);

  const servers: Array<{ provider: string; url: string }> = [];
  const catalog = await conn.query<{ DeveloperName: string; McpServerUrl__c?: string }>(
    'SELECT DeveloperName, McpServerUrl__c FROM ConnectorCatalog__mdt WHERE McpServerUrl__c != null',
  );
  for (const row of catalog.records) {
    if (row.McpServerUrl__c) servers.push({ provider: row.DeveloperName, url: row.McpServerUrl__c.replace(/\/+$/, '') });
  }
  try {
    const custom = await conn.query<{ Id: string; Name: string; McpServerUrl__c?: string }>(
      'SELECT Id, Name, McpServerUrl__c FROM CustomMcpServer__c WHERE IsActive__c = true',
    );
    for (const row of custom.records) {
      if (row.McpServerUrl__c) servers.push({ provider: `custom_${row.Id}`, url: row.McpServerUrl__c.replace(/\/+$/, '') });
    }
  } catch {
    /* org without the custom-server object — nothing to add */
  }

  const out: McpToolInventory[] = [];
  for (const s of servers) {
    try {
      const token = await resolveProviderToken({
        orgId,
        userId: '',
        provider: s.provider,
        connectorId: null,
        sfAccessToken: install?.sfAccessToken ?? null,
      });
      if (!token) {
        out.push({ provider: s.provider, url: s.url, tools: [], error: 'not connected' });
        continue;
      }
      const tools = await listToolsCached({ remoteUrl: s.url, accessToken: token });
      out.push({
        provider: s.provider,
        url: s.url,
        tools: tools.map(t => ({ name: t.name, description: (t.description ?? '').slice(0, 200) })),
      });
    } catch (err) {
      out.push({ provider: s.provider, url: s.url, tools: [], error: err instanceof Error ? err.message.slice(0, 150) : 'unreachable' });
    }
  }
  return out;
}

// ── Knowledge bases ──────────────────────────────────────────────────
export async function listKnowledgeBases(orgId: string): Promise<Array<{ agentApiName: string; documents: number; ready: number }>> {
  const rows = await prisma.kbDocument.groupBy({
    by: ['agentApiName'],
    where: { orgId },
    _count: { _all: true },
  });
  const ready = await prisma.kbDocument.groupBy({
    by: ['agentApiName'],
    where: { orgId, status: 'Ready' },
    _count: { _all: true },
  });
  const readyBy = new Map(ready.map(r => [r.agentApiName, r._count._all]));
  return rows.map(r => ({
    agentApiName: r.agentApiName,
    documents: r._count._all,
    ready: readyBy.get(r.agentApiName) ?? 0,
  }));
}

// ── The live capability manifest ─────────────────────────────────────
/**
 * Everything a spec's `action` may lawfully reference, as
 * kind:identity entries. Built fresh per build; also used again at
 * compile time. CRUD identities come from the integration user's real
 * object permissions (describeGlobal flags), so "can do" not "exists".
 */
export async function buildCapabilityManifest(orgId: string): Promise<{
  manifest: CapabilityManifest;
  counts: Record<string, number>;
}> {
  const [objects, invocables, mcp] = await Promise.all([
    listObjects(orgId),
    listInvocables(orgId),
    listMcpToolsLive(orgId),
  ]);

  const entries: string[] = [];
  for (const inv of invocables) {
    entries.push(`${inv.kind === 'apex' ? 'apex_invocable' : 'flow_invocable'}:${inv.name}`);
  }
  let mcpCount = 0;
  for (const server of mcp) {
    for (const t of server.tools) {
      entries.push(`mcp:${t.name}`);
      mcpCount++;
    }
  }
  let crudCount = 0;
  for (const o of objects) {
    if (o.createable) {
      entries.push(`crud:${o.name}:create`);
      crudCount++;
    }
    if (o.updateable) {
      entries.push(`crud:${o.name}:update`);
      crudCount++;
    }
    if (o.queryable) {
      entries.push(`crud:${o.name}:query`);
      crudCount++;
    }
  }

  return {
    manifest: manifestFromNames(entries),
    counts: {
      objects: objects.length,
      invocables: invocables.length,
      mcpTools: mcpCount,
      crudOperations: crudCount,
    },
  };
}

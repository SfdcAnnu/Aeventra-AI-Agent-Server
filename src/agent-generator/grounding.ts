/**
 * The org "grounding pack" for agent generation v2 — everything the
 * analyze/verify/generate passes need to resolve capabilities against
 * REALITY instead of guessing:
 *   - live tools/list of every connected MCP server (plus salesforce_mcp,
 *     which is org-level via Setup rather than a Connector row)
 *   - the org's invocable Apex actions and autolaunched Flows
 *   - the org's objects, with field detail for objects the requirement
 *     text actually mentions
 *
 * Every fetch is individually best-effort: a cold provider server or a
 * permissions gap degrades that one section to empty rather than failing
 * the whole analysis — the model is told what could not be inspected.
 */
import { getOrgConnection } from '../salesforce/per-org-connection';
import { resolveProviderToken } from '../chat/adapters/shared';
import { mcpListTools } from '../mcp/clients/streamable-http-client';
import { InstallsRepo } from '../db/installs.repo';
import { ConnectorsRepo } from '../db/connectors.repo';
import { logger } from '../logger';

export interface GroundingTool { name: string; description: string | null; }
export interface GroundingProvider { provider: string; displayName: string; tools: GroundingTool[]; }
export interface GroundingAction { type: 'apex' | 'flow'; name: string; label: string; }
export interface GroundingObjectField { name: string; label: string; type: string; }
export interface GroundingObject { name: string; label: string; custom: boolean; fields?: GroundingObjectField[]; }

export interface GroundingPack {
  providers: GroundingProvider[];
  customActions: GroundingAction[];
  objects: GroundingObject[];
  /** Sections that failed to load — surfaced to the model so it says
   *  "could not inspect X" instead of assuming X is empty. */
  unavailable: string[];
}

const MAX_DESCRIBED_OBJECTS = 5;
const MAX_FIELDS_PER_OBJECT = 40;
const API_VERSION = '62.0';

export async function gatherGrounding(orgId: string, requirementText: string): Promise<GroundingPack> {
  const pack: GroundingPack = { providers: [], customActions: [], objects: [], unavailable: [] };

  const conn = await getOrgConnection(orgId);
  const install = await InstallsRepo.findByOrgId(orgId);

  // ── Live MCP tools per provider ───────────────────────────────────
  const providerTargets: Array<{ provider: string; displayName: string }> = [
    { provider: 'salesforce_mcp', displayName: 'Salesforce' },
  ];
  try {
    const connected = await ConnectorsRepo.listForOrg(orgId);
    for (const c of connected) {
      if (c.status === 'Connected' && c.providerKey !== 'salesforce_mcp') {
        providerTargets.push({ provider: c.providerKey, displayName: c.displayName ?? c.providerKey });
      }
    }
  } catch (err) {
    pack.unavailable.push('connected provider list');
    logger.warn({ err, orgId }, 'grounding_connectors_failed');
  }

  for (const target of providerTargets) {
    try {
      const catalogRes = await conn.query<{ McpServerUrl__c?: string }>(
        `SELECT McpServerUrl__c FROM ConnectorCatalog__mdt WHERE DeveloperName = '${target.provider.replace(/'/g, "\\'")}' LIMIT 1`,
      );
      const baseUrl = catalogRes.records[0]?.McpServerUrl__c;
      if (!baseUrl) continue;
      const token = await resolveProviderToken({
        orgId, userId: '', provider: target.provider, connectorId: null,
        sfAccessToken: install?.sfAccessToken ?? null,
      });
      const tools = await mcpListTools({ remoteUrl: baseUrl, accessToken: token ?? '' });
      pack.providers.push({
        provider: target.provider,
        displayName: target.displayName,
        tools: tools.map(t => ({ name: t.name, description: (t.description ?? '').slice(0, 160) || null })),
      });
    } catch (err) {
      pack.unavailable.push(`${target.displayName} MCP tools`);
      logger.warn({ err, orgId, provider: target.provider }, 'grounding_mcp_tools_failed');
    }
  }

  // ── Invocable Apex actions + autolaunched Flows ───────────────────
  for (const type of ['apex', 'flow'] as const) {
    try {
      const r = await conn.request<{ actions?: Array<{ name: string; label?: string }> }>(
        `/services/data/v${API_VERSION}/actions/custom/${type}`);
      for (const a of r?.actions ?? []) pack.customActions.push({ type, name: a.name, label: a.label || a.name });
    } catch (err) {
      pack.unavailable.push(`${type === 'apex' ? 'invocable Apex actions' : 'autolaunched Flows'}`);
      logger.warn({ err, orgId, type }, 'grounding_custom_actions_failed');
    }
  }

  // ── Objects (+ fields for requirement-mentioned objects) ──────────
  try {
    const desc = await (conn as unknown as {
      describeGlobal: () => Promise<{ sobjects: Array<{ name: string; label: string; custom: boolean; queryable: boolean }> }>;
    }).describeGlobal();
    const usable = desc.sobjects.filter(
      s => s.queryable && !/Share$|History$|Feed$|Tag$|ChangeEvent$|__mdt$/.test(s.name),
    );
    pack.objects = usable.map(({ name, label, custom }) => ({ name, label, custom }));

    // Field detail only for objects the requirement plausibly refers to —
    // describing every object would be enormous and mostly noise.
    const req = requirementText.toLowerCase();
    const mentioned = usable.filter(s => {
      const label = s.label.toLowerCase();
      const bare = s.name.toLowerCase().replace(/__c$/, '').replace(/_/g, ' ');
      return (label.length > 3 && req.includes(label)) || (bare.length > 3 && req.includes(bare));
    }).slice(0, MAX_DESCRIBED_OBJECTS);

    for (const obj of mentioned) {
      try {
        const d = await (conn as unknown as {
          sobject: (n: string) => { describe: () => Promise<{ fields: Array<{ name: string; label: string; type: string }> }> };
        }).sobject(obj.name).describe();
        const entry = pack.objects.find(o => o.name === obj.name);
        if (entry) {
          entry.fields = d.fields.slice(0, MAX_FIELDS_PER_OBJECT).map(f => ({ name: f.name, label: f.label, type: f.type }));
        }
      } catch {
        // field detail is a bonus — the object list entry stays either way
      }
    }
  } catch (err) {
    pack.unavailable.push('org object list');
    logger.warn({ err, orgId }, 'grounding_describe_global_failed');
  }

  return pack;
}

/** Renders the pack into prompt text — compact, name-dense, model-facing. */
export function renderGrounding(pack: GroundingPack): string {
  const parts: string[] = [];

  for (const p of pack.providers) {
    parts.push(`CONNECTED MCP SERVER "${p.provider}" (${p.displayName}) — LIVE tools (EXACT names, nothing else exists):\n` +
      p.tools.map(t => `  - ${t.name}${t.description ? `: ${t.description}` : ''}`).join('\n'));
  }

  if (pack.customActions.length > 0) {
    parts.push('ORG AUTOMATION (invocable Apex actions and autolaunched Flows that ALREADY EXIST — prefer binding to one of these over inventing anything):\n' +
      pack.customActions.map(a => `  - [${a.type}] ${a.name} ("${a.label}")`).join('\n'));
  }

  const described = pack.objects.filter(o => o.fields && o.fields.length > 0);
  if (described.length > 0) {
    parts.push('ORG OBJECTS MENTIONED IN THE REQUIREMENT (real fields):\n' + described.map(o =>
      `  ${o.name} ("${o.label}"):\n` + (o.fields ?? []).map(f => `    - ${f.name} (${f.type})`).join('\n')).join('\n'));
  }
  if (pack.objects.length > 0) {
    const customNames = pack.objects.filter(o => o.custom).map(o => o.name).slice(0, 120);
    parts.push('ALL CUSTOM OBJECTS IN THE ORG: ' + (customNames.length > 0 ? customNames.join(', ') : '(none)'));
  }

  if (pack.unavailable.length > 0) {
    parts.push('COULD NOT INSPECT (do not assume these are empty — treat as unknown): ' + pack.unavailable.join(', '));
  }

  return parts.join('\n\n');
}

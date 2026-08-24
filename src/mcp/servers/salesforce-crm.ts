import type { Connection } from 'jsforce';
import type { Connector } from '@prisma/client';
import { getConnection } from '../../salesforce/client';
import { logger } from '../../logger';

/**
 * `salesforce-crm` MCP server — used by TRIGGER mode. Uses the shared
 * bootstrap jsforce connection to run reads/writes directly against SF.
 *
 * Chat mode does NOT go through this path — it uses the Managed MCP flow
 * (Claude/OpenAI hitting the standalone MCP server directly).
 *
 * The `connector` argument is accepted but ignored — historic API left in
 * place so callers don't need refactoring. All calls go through the
 * bootstrap connection.
 */

export type ConnectorRecord = Connector;

async function bootstrapConn(): Promise<Connection> {
  return getConnection();
}

type SfArgs<T> = T & { connector?: ConnectorRecord | null };

export async function sfGetRecord(args: SfArgs<{
  objectType: string;
  recordId: string;
  fields: string[];
}>): Promise<Record<string, unknown> | null> {
  if (!args.objectType || !args.recordId) throw new Error('objectType and recordId required');
  const conn = await bootstrapConn();
  const fieldList = args.fields.length > 0 ? args.fields : ['Id', 'Name'];
  return (await (conn as unknown as {
    sobject: (name: string) => { retrieve: (id: string, fields: string[]) => Promise<Record<string, unknown>> };
  }).sobject(args.objectType).retrieve(args.recordId, fieldList));
}

export async function sfUpdateRecord(args: SfArgs<{
  objectType: string;
  recordId: string;
  fields: Record<string, unknown>;
}>): Promise<unknown> {
  if (!args.objectType || !args.recordId) throw new Error('objectType and recordId required');
  const conn = await bootstrapConn();
  const payload = { Id: args.recordId, ...args.fields };
  const res = await (conn as unknown as {
    sobject: (name: string) => { update: (data: Record<string, unknown>) => Promise<{ id: string; success: boolean }> };
  }).sobject(args.objectType).update(payload);
  logger.info({ objectType: args.objectType, id: res.id, success: res.success }, 'sf_update_bootstrap');
  return res;
}

export async function sfCreateRecord(args: SfArgs<{
  objectType: string;
  fields: Record<string, unknown>;
}>): Promise<unknown> {
  if (!args.objectType) throw new Error('objectType required');
  const conn = await bootstrapConn();
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args.fields)) if (v !== undefined) cleaned[k] = v;
  const res = await (conn as unknown as {
    sobject: (name: string) => { create: (data: Record<string, unknown>) => Promise<{ id: string; success: boolean }> };
  }).sobject(args.objectType).create(cleaned);
  logger.info({ objectType: args.objectType, id: res.id, success: res.success }, 'sf_create_bootstrap');
  return res;
}

export async function sfQuery(args: SfArgs<{ soql: string }>): Promise<unknown> {
  if (!args.soql) throw new Error('soql required');
  const conn = await bootstrapConn();
  const res = await conn.query<Record<string, unknown>>(args.soql);
  return res.records;
}

/**
 * List all queryable SObjects in the org. AI uses this when the user's
 * instruction doesn't name a specific object, or to discover custom objects
 * in customer orgs we've never seen.
 *
 * Filters out non-data objects (Share, History, Feed, Tag, etc.) to keep the
 * response small. Cached for 1 hour per connection.
 */
let _sobjectsCache: { at: number; data: Array<{ name: string; label: string; custom: boolean }> } | null = null;
const SOBJECTS_TTL_MS = 60 * 60 * 1000;

export async function sfListSObjects(args?: SfArgs<{}>): Promise<Array<{ name: string; label: string; custom: boolean }>> {
  // No remote equivalent — always use the bootstrap describeGlobal.
  if (_sobjectsCache && Date.now() - _sobjectsCache.at < SOBJECTS_TTL_MS) return _sobjectsCache.data;
  const conn = await bootstrapConn();
  const desc = (await (conn as unknown as { describeGlobal: () => Promise<{ sobjects: Array<{ name: string; label: string; custom: boolean; queryable: boolean }> }> })
    .describeGlobal()) as { sobjects: Array<{ name: string; label: string; custom: boolean; queryable: boolean }> };
  const filtered = desc.sobjects
    .filter((s) => s.queryable && !/Share$|History$|Feed$|Tag$|ChangeEvent$|__mdt$/.test(s.name))
    .map(({ name, label, custom }) => ({ name, label, custom }));
  _sobjectsCache = { at: Date.now(), data: filtered };
  logger.info({ count: filtered.length }, 'sf_list_sobjects');
  return filtered;
}

/**
 * Describe one SObject's fields. AI calls this before any read/write to learn
 * the right field API names, types, picklist values, and required flags.
 *
 * Returned shape is trimmed — full describe responses are huge. We return just
 * what the AI needs to build a correct payload.
 */
export interface DescribedField {
  name: string;
  label: string;
  type: string;
  required: boolean;
  updateable: boolean;
  picklistValues?: string[];
  referenceTo?: string[];
}

export async function sfDescribeSObject(args: SfArgs<{ objectType: string }>): Promise<unknown> {
  if (!args.objectType) throw new Error('objectType required');
  const conn = await bootstrapConn();
  const desc = (await (conn as unknown as { sobject: (name: string) => { describe: () => Promise<{ name: string; label: string; fields: Array<Record<string, unknown>> }> } })
    .sobject(args.objectType)
    .describe()) as { name: string; label: string; fields: Array<Record<string, unknown>> };

  const fields: DescribedField[] = desc.fields.map((f) => {
    const out: DescribedField = {
      name: String(f.name),
      label: String(f.label),
      type: String(f.type),
      required: f.nillable === false && f.defaultedOnCreate !== true && f.type !== 'id',
      updateable: Boolean(f.updateable),
    };
    if (Array.isArray(f.picklistValues) && f.picklistValues.length > 0) {
      out.picklistValues = (f.picklistValues as Array<{ value: string; active: boolean }>)
        .filter((p) => p.active)
        .map((p) => p.value);
    }
    if (Array.isArray(f.referenceTo) && f.referenceTo.length > 0) {
      out.referenceTo = f.referenceTo as string[];
    }
    return out;
  });

  logger.info({ objectType: args.objectType, fieldCount: fields.length }, 'sf_describe_sobject');
  return { name: desc.name, label: desc.label, fields };
}

// ─────────────────────────────────────────────────────────────────────
// Phase 1 — run_report
// ─────────────────────────────────────────────────────────────────────

/**
 * Execute a saved Salesforce report via the Analytics REST API.
 *
 * jsforce exposes `conn.analytics.report(id).execute({ details })`. The
 * default response is summary-only; we flip `details: true` so the AI sees
 * the row factmap entries it can summarize.
 *
 * Returns a trimmed shape — the raw report can be huge (>1MB for tabular
 * reports with hundreds of rows). We bound it.
 */
export interface ReportRow {
  values: Record<string, string | number | null>;
}

export interface ReportResult {
  reportId: string;
  reportName: string;
  hasDetailRows: boolean;
  rows: ReportRow[];
  totalRowCount: number;
  truncated: boolean;
  groupingsDown?: string[];
  groupingsAcross?: string[];
}

const REPORT_ROW_CAP = 200;

export async function sfRunReport(args: SfArgs<{ reportId: string }>): Promise<ReportResult> {
  if (!args.reportId) throw new Error('reportId required');
  // No remote equivalent for Analytics — bootstrap connection only.
  const conn = await bootstrapConn();

  // jsforce v3 typing on analytics is loose — cast to a minimal shape
  type ReportInstance = {
    execute: (opts: { details: boolean }) => Promise<{
      attributes?: { reportName?: string };
      reportMetadata?: {
        name?: string;
        reportFormat?: string;
        groupingsDown?: Array<{ name?: string }>;
        groupingsAcross?: Array<{ name?: string }>;
        detailColumns?: string[];
      };
      reportExtendedMetadata?: {
        detailColumnInfo?: Record<string, { label?: string }>;
      };
      hasDetailRows?: boolean;
      factMap?: Record<string, {
        rows?: Array<{ dataCells?: Array<{ value?: unknown; label?: string }> }>;
        aggregates?: Array<{ value?: number; label?: string }>;
      }>;
    }>;
  };
  type AnalyticsApi = { report: (id: string) => ReportInstance };

  const analytics = (conn as unknown as { analytics: AnalyticsApi }).analytics;
  const raw = await analytics.report(args.reportId).execute({ details: true });

  const detailColumns = raw.reportMetadata?.detailColumns ?? [];
  const colInfo = raw.reportExtendedMetadata?.detailColumnInfo ?? {};

  // Factmap row keys look like "0!T" / "0_0!T" — we just want the all-rows entry.
  const factMapKey = Object.keys(raw.factMap ?? {}).find((k) => k.endsWith('!T')) ?? 'T!T';
  const factEntry = (raw.factMap ?? {})[factMapKey] ?? {};
  const rawRows = factEntry.rows ?? [];
  const totalRowCount = rawRows.length;
  const truncated = totalRowCount > REPORT_ROW_CAP;
  const limited = rawRows.slice(0, REPORT_ROW_CAP);

  const rows: ReportRow[] = limited.map((r) => {
    const cells = r.dataCells ?? [];
    const values: Record<string, string | number | null> = {};
    detailColumns.forEach((colKey, idx) => {
      const label = colInfo[colKey]?.label ?? colKey;
      const cell = cells[idx];
      if (!cell) { values[label] = null; return; }
      // Prefer the human-readable label, fall back to value
      const v = cell.label ?? cell.value;
      values[label] = (v === undefined || v === null) ? null : (typeof v === 'number' ? v : String(v));
    });
    return { values };
  });

  const result: ReportResult = {
    reportId: args.reportId,
    reportName: raw.reportMetadata?.name ?? raw.attributes?.reportName ?? '',
    hasDetailRows: raw.hasDetailRows ?? true,
    rows,
    totalRowCount,
    truncated,
  };
  if (raw.reportMetadata?.groupingsDown?.length) {
    result.groupingsDown = raw.reportMetadata.groupingsDown.map((g) => g.name ?? '').filter(Boolean);
  }
  if (raw.reportMetadata?.groupingsAcross?.length) {
    result.groupingsAcross = raw.reportMetadata.groupingsAcross.map((g) => g.name ?? '').filter(Boolean);
  }
  logger.info(
    { reportId: args.reportId, rowCount: rows.length, totalRowCount, truncated },
    'sf_run_report',
  );
  return result;
}

// ─────────────────────────────────────────────────────────────────────
// Phase 2 — delete_record
// ─────────────────────────────────────────────────────────────────────

export async function sfDeleteRecord(args: SfArgs<{
  objectType: string;
  recordId: string;
}>): Promise<unknown> {
  if (!args.objectType || !args.recordId) throw new Error('objectType and recordId required');
  const conn = await bootstrapConn();
  const res = await (conn as unknown as {
    sobject: (name: string) => { destroy: (id: string) => Promise<{ id: string; success: boolean }> };
  }).sobject(args.objectType).destroy(args.recordId);
  logger.info({ objectType: args.objectType, id: res.id, success: res.success }, 'sf_delete_bootstrap');
  return res;
}

// ─────────────────────────────────────────────────────────────────────
// Phase 2 — create_task
// ─────────────────────────────────────────────────────────────────────

/**
 * Create a standard Task record. Maps the AI-friendly arg names onto
 * Salesforce field names:
 *   - whatId  → WhatId  (Account/Opportunity/Case/custom)
 *   - whoId   → WhoId   (Lead/Contact)
 *   - dueDate → ActivityDate
 *
 * Supports the AgentScript-style date shorthand "TODAY", "TODAY+1", "TODAY+7"
 * which the AI tends to emit when the admin's instruction says "tomorrow" /
 * "next week".
 */
export async function sfCreateTask(args: SfArgs<{
  subject: string;
  whatId?: string;
  whoId?: string;
  dueDate?: string;
  priority?: string;
  status?: string;
  description?: string;
  ownerId?: string;
}>): Promise<unknown> {
  if (!args.subject) throw new Error('subject required');
  const conn = await bootstrapConn();

  const payload: Record<string, unknown> = {
    Subject: args.subject,
    Priority: args.priority ?? 'Normal',
    Status:   args.status ?? 'Not Started',
  };
  if (args.whatId)      payload.WhatId       = args.whatId;
  if (args.whoId)       payload.WhoId        = args.whoId;
  if (args.description) payload.Description  = args.description;
  if (args.ownerId)     payload.OwnerId      = args.ownerId;
  if (args.dueDate)     payload.ActivityDate = resolveActivityDate(args.dueDate);

  const res = (await (conn as unknown as {
    sobject: (name: string) => { create: (data: Record<string, unknown>) => Promise<{ id: string; success: boolean }> };
  })
    .sobject('Task')
    .create(payload)) as { id: string; success: boolean };
  logger.info({ taskId: res.id, success: res.success }, 'sf_create_task');
  return res;
}

/** "TODAY", "TODAY+1", "TODAY-3", or an ISO date string → ISO yyyy-MM-dd. */
function resolveActivityDate(input: string): string {
  const m = /^TODAY(?:([+-])(\d+))?$/i.exec(input.trim());
  if (m) {
    const sign = m[1] === '-' ? -1 : 1;
    const days = m[2] ? Number(m[2]) : 0;
    const d = new Date();
    d.setDate(d.getDate() + sign * days);
    return d.toISOString().slice(0, 10);
  }
  // Assume already an ISO date — trim time portion if present
  return input.slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────
// Phase 2 — post_chatter
// ─────────────────────────────────────────────────────────────────────

/**
 * Post a Chatter feed item on a record. Uses the Connect REST API at
 * /services/data/vXX.0/chatter/feed-elements which jsforce wraps via
 * `conn.chatter.resource('/feed-elements').create(payload)`.
 *
 * `mentions` is an optional array of user IDs which we render as @mentions
 * inline (Chatter doesn't support plain-text @mentions; you need the
 * messageSegment structure).
 */
export async function sfPostChatter(args: SfArgs<{
  recordId: string;
  message: string;
  mentions?: string[];
}>): Promise<{ id: string; url: string }> {
  if (!args.recordId || !args.message) throw new Error('recordId and message required');
  // No remote equivalent — bootstrap connection only.
  const conn = await bootstrapConn();

  const segments: Array<Record<string, unknown>> = [{ type: 'Text', text: args.message }];
  for (const userId of args.mentions ?? []) {
    segments.push({ type: 'Mention', id: userId });
  }

  const payload = {
    body: { messageSegments: segments },
    feedElementType: 'FeedItem',
    subjectId: args.recordId,
  };

  type ChatterApi = {
    resource: (path: string) => {
      create: (body: unknown) => Promise<{ id: string; url?: string }>;
    };
  };
  const chatter = (conn as unknown as { chatter: ChatterApi }).chatter;
  const res = await chatter.resource('/feed-elements').create(payload);
  logger.info({ feedItemId: res.id, recordId: args.recordId }, 'sf_post_chatter');
  return { id: res.id, url: res.url ?? '' };
}

// ─────────────────────────────────────────────────────────────────────
// Phase 2 — apex_invocable
// ─────────────────────────────────────────────────────────────────────

/**
 * Invoke an Apex Invocable method via the Actions REST API:
 *   POST /services/data/vXX.0/actions/custom/apex/<ClassName>
 *   Body: { "inputs": [ { ...params } ] }
 *
 * Salesforce returns an array of result envelopes — one per inputs[] entry.
 * We pass a single input so the response is `responses[0]`.
 *
 * Note: this only works for @InvocableMethod-decorated classes. If the AI
 * tries to invoke a class without that decorator the org returns 404.
 */
export async function sfApexInvocable(args: SfArgs<{
  className: string;
  params?: Record<string, unknown>;
}>): Promise<{
  isSuccess: boolean;
  outputValues?: Record<string, unknown>;
  errors?: Array<{ statusCode?: string; message: string; fields?: string[] }>;
}> {
  if (!args.className) throw new Error('className required');
  // No remote equivalent — bootstrap connection only.
  const conn = await bootstrapConn();

  const path = `/services/data/v62.0/actions/custom/apex/${encodeURIComponent(args.className)}`;
  const body = { inputs: [args.params ?? {}] };

  // jsforce v3 — conn.requestPost returns the parsed JSON envelope
  type RequestPost = (url: string, body: unknown, options?: { headers?: Record<string, string> }) => Promise<unknown>;
  const requestPost = (conn as unknown as { requestPost: RequestPost }).requestPost;
  const raw = await requestPost(path, body, { headers: { 'Content-Type': 'application/json' } });

  // The response is always an array; we sent one input so we read [0]
  const arr = Array.isArray(raw) ? raw as Array<{
    actionName?: string;
    isSuccess: boolean;
    outputValues?: Record<string, unknown>;
    errors?: Array<{ statusCode?: string; message: string; fields?: string[] }>;
  }> : [];
  const first = arr[0];
  if (!first) {
    logger.warn({ className: args.className, raw }, 'sf_apex_invocable_no_response');
    return { isSuccess: false, errors: [{ message: 'Empty response from Invocable Actions API' }] };
  }
  logger.info(
    { className: args.className, isSuccess: first.isSuccess },
    'sf_apex_invocable',
  );
  return {
    isSuccess: first.isSuccess,
    outputValues: first.outputValues,
    errors: first.errors,
  };
}

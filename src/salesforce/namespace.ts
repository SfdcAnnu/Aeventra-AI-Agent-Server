/**
 * Package namespace — one server, two kinds of org.
 *
 * The Salesforce side ships as a 2GP MANAGED package with the namespace
 * `archon`. In an org that installed it, every package object and field is
 * prefixed: ChatSession__c is archon__ChatSession__c, Title__c on it is
 * archon__Title__c, the AgentDefinition__r relationship is
 * archon__AgentDefinition__r. Standard fields (Id, Name, CreatedDate,
 * DeveloperName...) are not. The developer's own org deploys the same
 * source un-namespaced, and the server has to keep working there too.
 *
 * So the namespace is detected per org, once, and applied ONLY where the
 * server reads or writes its own package objects — through `pkgConn()`.
 *
 * NEVER GLOBAL. The same org connection runs agent tools against the
 * customer's own data, and a customer's Account.Status__c must never turn
 * into archon__Status__c. Package field names collide with ordinary
 * customer field names (Status__c, Description__c, Category__c...), so the
 * rewrite is safe only on queries whose FROM is a package object. That is
 * why nothing here hooks the Connection itself: each internal call site
 * opts in by going through `pkgConn(conn)`.
 *
 * With ns === '' every function below is the identity.
 */
import type { Connection } from 'jsforce';
import { logger } from '../logger';

/** The package's namespace prefix. `SF_PACKAGE_NAMESPACE=` (empty) turns
 *  detection off entirely — every org is treated as un-namespaced. */
export const PACKAGE_NAMESPACE: string = process.env.SF_PACKAGE_NAMESPACE ?? 'archon';

/**
 * Every package object and its custom fields, as the source declares them
 * (force-app/main/default/objects). Keep in step with the package: a field
 * missing here would be sent un-prefixed and fail in a subscriber org.
 * Standard fields must never appear in this list.
 */
export const PACKAGE_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  AgentApproval__c: [
    'AgentRunId__c', 'AgentApiName__c', 'NodeLabel__c', 'RecordId__c', 'ApproverId__c', 'Status__c',
    'ApprovalToken__c', 'Comments__c', 'TimeoutAt__c', 'DecidedAt__c',
  ],
  AgentDefinition__c: [
    'AccessMode__c', 'ApiName__c', 'CanvasJson__c', 'DebugMode__c', 'Department__c', 'Description__c',
    'ExecuteType__c', 'ExternalServerUrl__c', 'IsSystem__c', 'KnowledgeBase__c', 'PostTurnAutomationAgent__c',
    'SetupChecklistJson__c', 'Status__c', 'StreamReplies__c', 'SuccessRate__c', 'TotalExecutions__c', 'Version__c',
  ],
  AgentExecution__c: [
    'AgentDefinition__c', 'CorrelationId__c', 'RecordId__c', 'Status__c', 'AgentScore__c', 'AgentPriority__c',
    'AgentReason__c', 'ToolsUsed__c', 'ExecutionMs__c', 'InputPayload__c', 'OutputPayload__c', 'ErrorMessage__c',
    'Department__c', 'RunMode__c',
  ],
  AgentGuardrails__c: ['IsEnabled__c', 'MaxTokensPerDay__c', 'MaxTokensPerMonth__c'],
  AgentKbChunk__c: ['AgentApiName__c', 'DocumentExternalId__c', 'DocumentTitle__c', 'ChunkIndex__c', 'Content__c'],
  AgentNode__c: [
    'AgentDefinition__c', 'AiEngineConnection__c', 'ConfigJson__c', 'IsEnabled__c', 'McpServer__c', 'McpTool__c',
    'NodeSubType__c', 'NodeType__c', 'PositionX__c', 'PositionY__c', 'SortOrder__c',
  ],
  AiEngineConnection__c: [
    'ApiKey__c', 'AvailableModelsJson__c', 'DefaultModel__c', 'Endpoint__c', 'EngineType__c', 'IsActive__c',
    'IsPreferred__c', 'IsPublicShared__c', 'Label__c', 'LastUsedAt__c', 'LastValidatedAt__c', 'Notes__c',
    'OwnershipType__c', 'User__c', 'ValidationStatus__c',
  ],
  ChatMessage__c: [
    'ApprovalStatus__c', 'ApprovedAt__c', 'AttachedContentDocumentIds__c', 'CachedTokens__c', 'ChatSession__c',
    'Content__c', 'Feedback__c', 'LatencyMs__c', 'ModelUsed__c', 'PhaseMsJson__c', 'RequestPayload__c',
    'RequiredApproval__c', 'ResponsePayload__c', 'Role__c', 'Sensitive__c', 'SequenceNumber__c', 'TokensIn__c',
    'TokensOut__c', 'ToolCallsJson__c', 'ToolResultsJson__c', 'TurnStatus__c', 'UsageJson__c',
  ],
  ChatSession__c: [
    'ActiveTopic__c', 'AgentDefinition__c', 'CachedTokens__c', 'Channel__c', 'Department__c', 'ExpiresAt__c',
    'LastActivityAt__c', 'LatencyMsTotal__c', 'MemoryCoveredCount__c', 'MemoryFactsJson__c', 'MemorySummary__c',
    'PendingApprovalToken__c', 'RecordContextId__c', 'RecordContextType__c', 'SenderPhone__c', 'Status__c',
    'TitleGeneratedByAi__c', 'Title__c', 'TokensIn__c', 'TokensOut__c', 'TotalTurns__c', 'UsageByModelJson__c',
    'User__c',
  ],
  ConnectorCatalog__mdt: [
    'AuthType__c', 'AuthorizeUrl__c', 'BrandColor__c', 'Category__c', 'Description__c', 'DisplayName__c',
    'IconStaticResource__c', 'IsPopular__c', 'MapsToCatalogType__c', 'McpServerUrl__c', 'Scopes__c',
    'SortOrder__c', 'TokenUrl__c',
  ],
  CustomMcpServer__c: ['CatalogType__c', 'Category__c', 'Description__c', 'IsActive__c', 'McpServerUrl__c'],
  ArchonInstall__c: ['ConfiguredAt__c', 'ConfiguredByEmail__c', 'SessionKey__c'],
  ArchonConfig__mdt: ['JwtSecret__c', 'ServerUrl__c'],
};

/** Relationship names of the package's lookup / master-detail fields. */
export const PACKAGE_RELATIONSHIPS: readonly string[] = [
  'AgentDefinition__r',          // AgentNode, ChatSession, AgentExecution
  'AiEngineConnection__r',       // AgentNode
  'ChatSession__r',              // ChatMessage
  'User__r',                     // ChatSession, AiEngineConnection
  'PostTurnAutomationAgent__r',  // AgentDefinition
  'ApproverId__r',               // AgentApproval
];

const STANDARD_NEVER = new Set(['id', 'name', 'ownerid', 'createddate', 'lastmodifieddate', 'developername', 'masterlabel']);

/** lower-cased name -> canonical name, for every rewritable token. */
const KNOWN = new Map<string, string>();
const OBJECTS = new Map<string, string>();
for (const [obj, fields] of Object.entries(PACKAGE_SCHEMA)) {
  KNOWN.set(obj.toLowerCase(), obj);
  OBJECTS.set(obj.toLowerCase(), obj);
  for (const f of fields) KNOWN.set(f.toLowerCase(), f);
}
for (const r of PACKAGE_RELATIONSHIPS) KNOWN.set(r.toLowerCase(), r);
for (const s of STANDARD_NEVER) KNOWN.delete(s);   // belt and braces

/** Whether `name` is a package object, field or relationship name. */
export function isPackageName(name: string): boolean {
  return KNOWN.has(name.toLowerCase());
}

/** Whether `name` is a package OBJECT (sObject or custom metadata type). */
export function isPackageObject(name: string): boolean {
  const bare = name.includes('__') && name.toLowerCase().startsWith(`${PACKAGE_NAMESPACE.toLowerCase()}__`)
    ? name.slice(PACKAGE_NAMESPACE.length + 2)
    : name;
  return OBJECTS.has(bare.toLowerCase());
}

/** A single package name, prefixed. Anything else is returned untouched. */
export function nsName(name: string, ns: string): string {
  if (!ns || !KNOWN.has(name.toLowerCase())) return name;
  return `${ns}__${name}`;
}

/**
 * Prefix every whole-word package name in a SOQL or SOSL statement.
 *
 * Quoted string literals ('...') and SOSL search terms ({...}) are copied
 * verbatim — a value that happens to spell a field name is data, not a
 * name. A token that already carries a namespace (archon__X__c) is not a
 * known name and so is left alone, which makes the rewrite idempotent.
 */
export function nsSoql(soql: string, ns: string): string {
  if (!ns) return soql;
  let out = '';
  let i = 0;
  const n = soql.length;
  while (i < n) {
    const ch = soql[i];
    if (ch === '\'' || ch === '{') {
      const close = ch === '\'' ? '\'' : '}';
      let j = i + 1;
      while (j < n && soql[j] !== close) j += soql[j] === '\\' ? 2 : 1;
      out += soql.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(soql[j])) j++;
      const word = soql.slice(i, j);
      out += KNOWN.has(word.toLowerCase()) ? `${ns}__${word}` : word;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Prefix the keys of a record (or array of records) before a DML call. */
export function nsRecordOut<T>(record: T, ns: string): T {
  if (!ns) return record;
  if (Array.isArray(record)) return record.map(r => nsRecordOut(r, ns)) as unknown as T;
  if (!record || typeof record !== 'object') return record;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record as Record<string, unknown>)) out[nsName(k, ns)] = v;
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Strip the namespace from every key of a result — nested relationship
 * objects and `records` / `searchRecords` arrays included — plus the
 * `attributes.type` of each record. Values are never touched otherwise.
 * Only ever applied to results of package-object calls.
 */
export function stripNs<T>(value: T, ns: string): T {
  if (!ns) return value;
  const prefix = `${ns}__`;
  const strip = (s: string) => (s.startsWith(prefix) && s.length > prefix.length && s.includes('__', prefix.length) ? s.slice(prefix.length) : s);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isPlainObject(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(v)) {
      if (k === 'attributes' && isPlainObject(inner) && typeof inner.type === 'string') {
        out[k] = { ...inner, type: strip(inner.type) };
      } else {
        out[strip(k)] = walk(inner);
      }
    }
    return out;
  };
  return walk(value) as T;
}

/** A describe result with its object, field and relationship names stripped. */
export function stripDescribe<T>(desc: T, ns: string): T {
  if (!ns || !desc || typeof desc !== 'object') return desc;
  const prefix = `${ns}__`;
  const strip = (s: unknown) => (typeof s === 'string' && s.startsWith(prefix) ? s.slice(prefix.length) : s);
  const d = desc as Record<string, unknown>;
  const fields = Array.isArray(d.fields)
    ? (d.fields as Array<Record<string, unknown>>).map(f => ({
        ...f,
        name: strip(f.name),
        relationshipName: strip(f.relationshipName),
        referenceTo: Array.isArray(f.referenceTo) ? f.referenceTo.map(strip) : f.referenceTo,
      }))
    : d.fields;
  return { ...d, name: strip(d.name), fields } as T;
}

// ─── Per-org detection ────────────────────────────────────────────────────

const DETECT_RETRY_MS = 60_000;
const detected = new Map<string, Promise<string>>();
const failedAt = new Map<string, number>();

function orgKey(conn: Connection): string {
  const c = conn as unknown as { instanceUrl?: string; userInfo?: { organizationId?: string } };
  return c.userInfo?.organizationId || c.instanceUrl || '';
}

function isNotFound(err: unknown): boolean {
  const e = err as { errorCode?: string; name?: string; message?: string } | null;
  const text = `${e?.errorCode ?? ''} ${e?.name ?? ''} ${e?.message ?? ''}`;
  return /NOT_FOUND|INVALID_TYPE|does not exist|not supported/i.test(text);
}

/**
 * '' or the package namespace, for the org behind `conn`. Detected once
 * per org with a single describe of the namespaced ChatSession object and
 * cached for the life of the process. Never throws: a failed detection
 * (network, expired token) answers '' and is retried after a minute, so a
 * blip is not remembered as "no package".
 */
export async function getOrgNamespace(conn: Connection): Promise<string> {
  if (!PACKAGE_NAMESPACE) return '';
  const key = orgKey(conn);
  const cached = key ? detected.get(key) : undefined;
  if (cached) return cached;
  if (key && Date.now() - (failedAt.get(key) ?? 0) < DETECT_RETRY_MS) return '';

  const probe = `${PACKAGE_NAMESPACE}__ChatSession__c`;
  const p = (async (): Promise<string> => {
    const describe = (conn as unknown as { describe?: (t: string) => Promise<{ name?: string }> }).describe;
    if (typeof describe !== 'function') throw new Error('connection has no describe');
    try {
      const d = await describe.call(conn, probe);
      if (d?.name?.toLowerCase() === probe.toLowerCase()) return PACKAGE_NAMESPACE;
      throw new Error('unexpected describe result');
    } catch (err) {
      if (isNotFound(err)) return '';   // definitive: the package is not installed
      throw err;
    }
  })();

  if (!key) return p.catch(() => '');
  // The HANDLED promise is what is cached, so every concurrent caller gets
  // a string — never a rejection — and a failure evicts itself.
  const handled = p.then(
    ns => {
      logger.info({ org: key, namespace: ns || '(none)' }, 'org_namespace_detected');
      return ns;
    },
    err => {
      detected.delete(key);
      failedAt.set(key, Date.now());
      logger.warn({ org: key, err: err instanceof Error ? err.message : String(err) }, 'org_namespace_detect_failed');
      return '';
    },
  );
  detected.set(key, handled);
  return handled;
}

/** Test hook / manual override: pin an org's namespace, or clear the cache. */
export function setOrgNamespace(key: string, ns: string | null): void {
  failedAt.delete(key);
  if (ns === null) detected.delete(key);
  else detected.set(key, Promise.resolve(ns));
}
export function clearOrgNamespaceCache(): void {
  detected.clear();
  failedAt.clear();
}

// ─── The wrapper internal call sites use ─────────────────────────────────

export interface PkgQueryResult<T> {
  totalSize: number;
  done: boolean;
  nextRecordsUrl?: string;
  records: T[];
}
export interface PkgSaveResult {
  id: string;
  success: boolean;
  errors: unknown[];
  created?: boolean;
}
type SaveFor<R> = R extends readonly unknown[] ? PkgSaveResult[] : PkgSaveResult;

export interface PkgSObject {
  create<R extends object>(records: R): Promise<SaveFor<R>>;
  insert<R extends object>(records: R): Promise<SaveFor<R>>;
  update<R extends object>(records: R): Promise<SaveFor<R>>;
  upsert<R extends object>(records: R, extIdField: string): Promise<SaveFor<R>>;
  destroy<I extends string | string[]>(ids: I): Promise<I extends string[] ? PkgSaveResult[] : PkgSaveResult>;
  retrieve<T = Record<string, unknown>>(id: string, fields?: string[]): Promise<T>;
  describe(): Promise<{ name: string; fields: Array<{ name: string; type?: string; relationshipName?: string | null; referenceTo?: string[] } & Record<string, unknown>> } & Record<string, unknown>>;
}

export interface PkgConn {
  /** The underlying connection, for anything that is NOT a package object. */
  readonly conn: Connection;
  /** This org's namespace ('' when un-namespaced). */
  namespace(): Promise<string>;
  query<T = Record<string, any>>(soql: string): Promise<PkgQueryResult<T>>;
  search(sosl: string): Promise<{ searchRecords: Array<Record<string, any>> }>;
  sobject(name: string): PkgSObject;
  /** Prefix a single package name for this org (object, field, relationship). */
  name(name: string): Promise<string>;
}

type AnySObject = {
  create: (r: unknown) => Promise<unknown>;
  insert?: (r: unknown) => Promise<unknown>;
  update: (r: unknown) => Promise<unknown>;
  upsert: (r: unknown, ext: string) => Promise<unknown>;
  destroy: (ids: unknown) => Promise<unknown>;
  retrieve: (id: string, opts?: unknown) => Promise<unknown>;
  describe: () => Promise<unknown>;
};

/**
 * The connection as seen by code that reads or writes the server's own
 * package objects: names go out prefixed for the org, results come back
 * with the prefix stripped, so call sites keep using bare names either way.
 * Use ONLY for package objects — never for customer data.
 */
export function pkgConn(conn: Connection): PkgConn {
  const ns = () => getOrgNamespace(conn);
  const raw = conn as unknown as {
    query: (s: string) => Promise<unknown>;
    search: (s: string) => Promise<unknown>;
    sobject: (n: string) => AnySObject;
  };
  const sobj = async (name: string) => {
    const n = await ns();
    return { n, so: raw.sobject(nsName(name, n)) };
  };
  return {
    conn,
    namespace: ns,
    async name(name) { return nsName(name, await ns()); },
    async query<T>(soql: string) {
      const n = await ns();
      return stripNs(await raw.query(nsSoql(soql, n)), n) as PkgQueryResult<T>;
    },
    async search(sosl) {
      const n = await ns();
      return stripNs(await raw.search(nsSoql(sosl, n)), n) as { searchRecords: Array<Record<string, any>> };
    },
    sobject(name) {
      const api: PkgSObject = {
        async create(records) { const { n, so } = await sobj(name); return so.create(nsRecordOut(records, n)) as never; },
        async insert(records) {
          const { n, so } = await sobj(name);
          const fn = typeof so.insert === 'function' ? so.insert : so.create;
          return fn.call(so, nsRecordOut(records, n)) as never;
        },
        async update(records) { const { n, so } = await sobj(name); return so.update(nsRecordOut(records, n)) as never; },
        async upsert(records, extIdField) {
          const { n, so } = await sobj(name);
          return so.upsert(nsRecordOut(records, n), nsName(extIdField, n)) as never;
        },
        async destroy(ids) { const { so } = await sobj(name); return so.destroy(ids) as never; },
        async retrieve<T>(id: string, fields?: string[]) {
          const { n, so } = await sobj(name);
          const res = fields ? await so.retrieve(id, { fields: fields.map(f => nsName(f, n)) }) : await so.retrieve(id);
          return stripNs(res, n) as T;
        },
        async describe() { const { n, so } = await sobj(name); return stripDescribe(await so.describe(), n) as never; },
      };
      return api;
    },
  };
}

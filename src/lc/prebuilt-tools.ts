/**
 * prebuilt-tools — GENERIC executor for admin-configured Salesforce actions.
 *
 * A tool node with actionType 'Prebuilt' carries its whole definition as
 * CONFIG (operation, object, ticked fields, bindings) — set with pickers in
 * the builder UI from the org's real schema. This module turns each one
 * into a TYPED LangChain tool: the model fills named, typed parameters and
 * physically cannot touch fields the admin didn't tick. Nothing here is
 * use-case-specific; the use case lives entirely in the node's config.
 *
 * Record binding ("bind to the conversation's record"): bound fields are
 * NOT parameters — the server injects them from the session's anchored
 * record at execution time (WhatId/Id = the record, WhoId = its Contact),
 * which makes the wrong-Id failure class structurally impossible
 * (live-confirmed: an Account Id passed as WhoId killed an Event create).
 *
 * v1 operations: create, update, get, search. Delete/bulk are deliberately
 * NOT executed until approval enforcement lands on this path.
 */
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { nextNodes, type GraphAdjacency } from '../orchestrator/graph';
import { logger } from '../logger';
import type { AgentNode } from '../types';

const SAFE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,80}$/;
const OPERATIONS = new Set(['create', 'update', 'get', 'search']);

interface PrebuiltField {
  name: string;
  label?: string;
  type?: string;
  required?: boolean;
  picklistValues?: string[];
}

interface PrebuiltConfig {
  actionType?: string;
  operation?: string;
  object?: string;
  selectedFields?: PrebuiltField[];
  boundFields?: string[];      // e.g. ['WhatId','WhoId'] or ['Id']
  description?: string;
}

interface TurnContext {
  orgId: string;
  recordContextId?: string | null;
  recordContextType?: string | null;
}

/** Same slug rule as subagent-router's handoff names: provider-safe,
 *  collision-proofed with a node-id suffix. Write ops get a `do_` prefix,
 *  reads a `find_` prefix — output-guardrails counts `do_` tools as writes
 *  for the action-claim guard. */
function slug(prefix: string, name: string, nodeId: string): string {
  const suffix = nodeId.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, '');
  const maxBase = Math.max(64 - (prefix.length + 2 + suffix.length), 1);
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, maxBase);
  return `${prefix}_${base || 'action'}_${suffix}`;
}

function zodForField(f: PrebuiltField, optional: boolean): z.ZodTypeAny {
  const t = (f.type ?? '').toLowerCase();
  let base: z.ZodTypeAny;
  if (['int', 'integer', 'double', 'currency', 'percent', 'number'].includes(t)) base = z.number();
  else if (t === 'boolean') base = z.boolean();
  else base = z.string();

  let desc = f.label && f.label !== f.name ? f.label : f.name;
  if (t === 'date') desc += ' (YYYY-MM-DD)';
  if (t === 'datetime') desc += ' (ISO 8601, e.g. 2026-09-04T10:00:00Z)';
  if (f.picklistValues?.length) desc += ` — one of: ${f.picklistValues.slice(0, 15).join(', ')}`;
  base = base.describe(desc);
  return optional ? base.optional() : base;
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** The anchored record's Contact Id — generic best-effort (works for any
 *  object with a ContactId field); returns null rather than guessing. */
async function resolveBoundContact(ctx: TurnContext): Promise<string | null> {
  if (!ctx.recordContextId || !ctx.recordContextType || !SAFE_NAME_RE.test(ctx.recordContextType)) return null;
  try {
    const conn = await getOrgConnection(ctx.orgId);
    const safeId = ctx.recordContextId.replace(/[^a-zA-Z0-9]/g, '');
    const r = await conn.query<{ ContactId?: string }>(
      `SELECT ContactId FROM ${ctx.recordContextType} WHERE Id = '${safeId}' LIMIT 1`);
    return r.records[0]?.ContactId ?? null;
  } catch {
    return null;
  }
}

/** Build typed tools for every enabled 'Prebuilt' tool node attached to
 *  ownerNode's tool port. Invalid configs are skipped with a log, never a
 *  crash. */
export function buildPrebuiltTools(
  ctx: TurnContext,
  graph: GraphAdjacency,
  ownerNode: AgentNode,
): StructuredToolInterface[] {
  const nodes = nextNodes(graph, ownerNode.id, 'tool')
    .filter(n => n.isEnabled && n.nodeType === 'tool' && (n.config as PrebuiltConfig)?.actionType === 'Prebuilt');

  const tools: StructuredToolInterface[] = [];
  for (const node of nodes) {
    const cfg = node.config as PrebuiltConfig;
    const op = String(cfg.operation ?? '');
    const object = String(cfg.object ?? '');
    if (!OPERATIONS.has(op) || !SAFE_NAME_RE.test(object)) {
      logger.warn({ node: node.id, op, object }, 'prebuilt_tool_skipped_invalid');
      continue;
    }
    const fields = (cfg.selectedFields ?? []).filter(f => f?.name && SAFE_NAME_RE.test(f.name));
    const bound = new Set((cfg.boundFields ?? []).filter(b => typeof b === 'string'));
    const paramFields = fields.filter(f => !bound.has(f.name));
    if (fields.length === 0) {
      logger.warn({ node: node.id }, 'prebuilt_tool_skipped_no_fields');
      continue;
    }

    const shape: Record<string, z.ZodTypeAny> = {};
    for (const f of paramFields) {
      // create: honor required flags; update/search: everything optional
      // (set/match only what the conversation provides); get: no field params.
      if (op === 'get') continue;
      shape[f.name] = zodForField(f, op !== 'create' || f.required !== true);
    }
    // Non-bound record identity for update/get on records the conversation
    // isn't anchored to.
    const needsIdParam = (op === 'update' || op === 'get') && !bound.has('Id');
    if (needsIdParam) shape.recordId = z.string().describe(`Id of the ${object} record`);

    const name = slug(op === 'create' || op === 'update' ? 'do' : 'find', node.name, node.id);
    const description =
      `${cfg.description?.trim() || node.name} ` +
      `[${op} ${object}${bound.size > 0 ? ' — record identity is filled in automatically from this conversation' : ''}]`;

    tools.push(tool(
      async (args: Record<string, unknown>) => executePrebuilt(ctx, op, object, fields, bound, args ?? {}, needsIdParam),
      { name, description, schema: z.object(shape) },
    ) as StructuredToolInterface);
  }
  return tools;
}

async function executePrebuilt(
  ctx: TurnContext,
  op: string,
  object: string,
  fields: PrebuiltField[],
  bound: Set<string>,
  args: Record<string, unknown>,
  usedIdParam: boolean,
): Promise<string> {
  try {
    const conn = await getOrgConnection(ctx.orgId);
    const fieldNames = new Set(fields.map(f => f.name));

    // Values the model provided, restricted to ticked fields only.
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (fieldNames.has(k) && !bound.has(k) && v !== undefined && v !== null && v !== '') values[k] = v;
    }
    // Server-injected bindings — never the model's to supply.
    if (bound.size > 0 && ctx.recordContextId) {
      if (bound.has('WhatId')) values.WhatId = ctx.recordContextId;
      if (bound.has('WhoId')) {
        const contactId = await resolveBoundContact(ctx);
        if (contactId) values.WhoId = contactId;
      }
    }

    if (op === 'create') {
      const res = await conn.sobject(object).create(values) as { success?: boolean; id?: string; errors?: unknown[] };
      return res.success ? `Created ${object} ${res.id}.` : `Create failed: ${JSON.stringify(res.errors).slice(0, 300)}`;
    }

    const recordId = bound.has('Id')
      ? (ctx.recordContextId ?? '')
      : String(usedIdParam ? (args.recordId ?? '') : '');

    if (op === 'update') {
      if (!recordId) return 'Error: no record Id available for the update.';
      if (Object.keys(values).length === 0) return 'Error: provide at least one field to update.';
      const res = await conn.sobject(object).update({ Id: recordId, ...values }) as { success?: boolean; errors?: unknown[] };
      return res.success ? `Updated ${object} ${recordId}.` : `Update failed: ${JSON.stringify(res.errors).slice(0, 300)}`;
    }

    if (op === 'get') {
      if (!recordId) return 'Error: no record Id available.';
      const safeId = recordId.replace(/[^a-zA-Z0-9]/g, '');
      const r = await conn.query<Record<string, unknown>>(
        `SELECT ${[...fieldNames].join(', ')} FROM ${object} WHERE Id = '${safeId}' LIMIT 1`);
      return r.records.length ? JSON.stringify(r.records[0]).slice(0, 2000) : `No ${object} found with Id ${safeId}.`;
    }

    // search — equality/LIKE over the provided params, ticked fields returned.
    const clauses: string[] = [];
    for (const [k, v] of Object.entries(values)) {
      const f = fields.find(x => x.name === k);
      const t = (f?.type ?? '').toLowerCase();
      if (typeof v === 'number' || typeof v === 'boolean') clauses.push(`${k} = ${v}`);
      else if (['string', 'textarea', 'text', 'email', 'phone', 'url', ''].includes(t)) clauses.push(`${k} LIKE '%${esc(String(v))}%'`);
      else clauses.push(`${k} = '${esc(String(v))}'`);
    }
    if (clauses.length === 0) return 'Error: provide at least one field value to search by.';
    const soql = `SELECT Id, ${[...fieldNames].join(', ')} FROM ${object} WHERE ${clauses.join(' AND ')} LIMIT 10`;
    const r = await conn.query<Record<string, unknown>>(soql);
    return JSON.stringify({ totalSize: r.records.length, records: r.records }).slice(0, 3000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ orgId: ctx.orgId, op, object, err: msg }, 'prebuilt_tool_failed');
    return `Error: ${msg.slice(0, 300)}. Fix the inputs and retry, or tell the customer the team will follow up.`;
  }
}

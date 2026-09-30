/**
 * FIELD CHECK -- every field a design names, against the org's describe.
 *
 * The Surveyor inventories objects, never fields, and the validator checks
 * tool and object names only. So a design could query a field the org does
 * not have, or filter on one SOQL cannot filter, and nothing noticed until
 * a customer was talking to the agent. Both happened in the 30 Sep 2026
 * test run: a pricing helper selected PricebookEntry.CurrencyIsoCode (a
 * single-currency org has no such field) and told the customer the product
 * did not exist; a booking agent de-duplicated Tasks with
 * "WHERE Description LIKE ...", which SOQL refuses, and never wrote its
 * summary Task.
 *
 * Deliberately conservative: only plain field names on the object in FROM
 * (or the step's object) are checked. Relationship paths (Account.Name),
 * functions, sub-queries and placeholders are skipped, and an object that
 * cannot be described is skipped -- a checker that guesses would fail good
 * builds, which is worse than the gap it closes.
 */
import type { AgentSpec, SpecError } from './spec';

export interface FieldFacts {
  /** Lower-cased field name -> what the org says about it. */
  fields: Map<string, { name: string; filterable: boolean; createable: boolean; updateable: boolean }>;
}

/** Describes one object, or null when it cannot be described. */
export type DescribeFields = (objectName: string) => Promise<FieldFacts | null>;

type Use = 'read' | 'filter' | 'create' | 'update';

interface FieldRef {
  object: string;
  field: string;
  use: Use;
  /** Where it was found, as a spec path the design stage can act on. */
  path: string;
}

const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const PLAIN_NAME_RE = new RegExp(`^${NAME}$`);
const SOQL_RE = new RegExp(`\\bSELECT\\s+([\\s\\S]+?)\\s+FROM\\s+(${NAME})\\b([^\\n"\`]*)`, 'gi');
const FILTER_RE = new RegExp(`(${NAME}(?:\\.${NAME})*)\\s*(?:=|!=|<>|<=|>=|<|>|\\bNOT\\s+LIKE\\b|\\bLIKE\\b|\\bNOT\\s+IN\\b|\\bIN\\b|\\bINCLUDES\\b|\\bEXCLUDES\\b)`, 'gi');
const SOQL_WORDS = new Set(['and', 'or', 'not', 'null', 'true', 'false', 'today', 'yesterday', 'tomorrow', 'last_n_days', 'next_n_days']);

/** Quoted literals out, so "Name = 'a = b'" cannot yield field "a". */
const withoutLiterals = (s: string): string => s.replace(/'(?:\\.|[^'\\])*'/g, "''");

/** Split a SELECT list on top-level commas (sub-queries and functions keep theirs). */
function selectItems(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

/** Every plain field one piece of text's SOQL reads or filters on. */
export function soqlFieldRefs(text: string, path: string): FieldRef[] {
  const out: FieldRef[] = [];
  for (const m of withoutLiterals(text).matchAll(SOQL_RE)) {
    const object = m[2];
    for (const item of selectItems(m[1])) {
      const first = item.split(/\s+/)[0];
      if (PLAIN_NAME_RE.test(first) && !first.includes('.')) out.push({ object, field: first, use: 'read', path });
    }
    // The WHERE clause: up to ORDER BY / GROUP BY / LIMIT / OFFSET.
    const where = /\bWHERE\b([\s\S]*?)(?:\bORDER\s+BY\b|\bGROUP\s+BY\b|\bLIMIT\b|\bOFFSET\b|$)/i.exec(m[3]);
    if (where) {
      for (const f of where[1].matchAll(FILTER_RE)) {
        const field = f[1];
        if (field.includes('.') || SOQL_WORDS.has(field.toLowerCase())) continue;
        out.push({ object, field, use: 'filter', path });
      }
    }
  }
  return out;
}

type Step = Record<string, unknown>;

function flowRefs(steps: unknown, base: string, out: FieldRef[]): void {
  if (!Array.isArray(steps)) return;
  steps.forEach((raw, i) => {
    const s = (raw ?? {}) as Step;
    const p = `${base}/${i}`;
    const object = typeof s.object === 'string' ? s.object : '';
    if (s.step === 'query_records' && typeof s.soql === 'string') out.push(...soqlFieldRefs(s.soql, `${p}/soql`));
    if ((s.step === 'create_record' || s.step === 'update_record') && object && s.fields && typeof s.fields === 'object') {
      for (const field of Object.keys(s.fields as object)) {
        if (PLAIN_NAME_RE.test(field)) out.push({ object, field, use: s.step === 'create_record' ? 'create' : 'update', path: `${p}/fields/${field}` });
      }
    }
    if (s.step === 'get_record' && object && typeof s.fields === 'string') {
      for (const field of s.fields.split(',').map(x => x.trim())) {
        if (PLAIN_NAME_RE.test(field)) out.push({ object, field, use: 'read', path: `${p}/fields` });
      }
    }
    for (const k of ['then', 'else', 'body', 'approved', 'rejected']) flowRefs(s[k], `${p}/${k}`, out);
  });
}

/** Every field the design names, and where. */
export function collectFieldRefs(spec: AgentSpec, opts: { instructions: boolean }): FieldRef[] {
  const out: FieldRef[] = [];
  flowRefs((spec as { flow?: unknown }).flow, '/flow', out);
  spec.nodes.forEach((n, i) => {
    if (opts.instructions && typeof n.instructions === 'string') out.push(...soqlFieldRefs(n.instructions, `/nodes/${i}/instructions`));
    for (const input of n.inputs ?? []) {
      if (typeof input.value === 'string' && /\bselect\b/i.test(input.value)) {
        out.push(...soqlFieldRefs(input.value, `/nodes/${i}/inputs/${input.name}`));
      }
    }
  });
  return out;
}

const USE_WORD: Record<Use, string> = { read: 'read', filter: 'filtered on', create: 'set on create', update: 'set on update' };

/**
 * The problems, as spec errors: a field the object does not have, one that
 * cannot be filtered, created or updated the way the design uses it. The
 * message names real fields the object does have that look close, so the
 * designer can fix it in one pass.
 */
export async function fieldProblems(refs: FieldRef[], describe: DescribeFields): Promise<SpecError[]> {
  const errors: SpecError[] = [];
  const seen = new Set<string>();
  const facts = new Map<string, Promise<FieldFacts | null>>();
  for (const r of refs) {
    const key = `${r.path}|${r.object}.${r.field}|${r.use}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const objKey = r.object.toLowerCase();
    if (!facts.has(objKey)) facts.set(objKey, describe(r.object).catch(() => null));
    const f = await facts.get(objKey)!;
    if (!f) continue;
    const field = f.fields.get(r.field.toLowerCase());
    if (!field) {
      errors.push({ path: r.path, message: `${r.object} has no field "${r.field}"${closest(r.field, f)}. Use a field that exists, or drop it.` });
      continue;
    }
    const allowed = r.use === 'filter' ? field.filterable : r.use === 'create' ? field.createable : r.use === 'update' ? field.updateable : true;
    if (!allowed) {
      const hint = r.use === 'filter'
        ? ' (long text and some other types cannot be used in WHERE; match on Subject, a related Id or a date instead)'
        : '';
      errors.push({ path: r.path, message: `${r.object}.${field.name} cannot be ${USE_WORD[r.use]}${hint}.` });
    }
  }
  return errors;
}

function closest(wanted: string, f: FieldFacts): string {
  const w = wanted.toLowerCase().replace(/__c$/, '');
  const near = [...f.fields.values()]
    .map(x => x.name)
    .filter(n => { const l = n.toLowerCase(); return l.includes(w) || w.includes(l.replace(/__c$/, '')); })
    .slice(0, 5);
  return near.length ? ` (did you mean ${near.join(', ')}?)` : '';
}

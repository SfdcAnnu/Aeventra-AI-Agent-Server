/**
 * EXPRESSIONS FOR AUTOMATION STEPS — conditions and values the engine
 * evaluates itself, without a model.
 *
 * The if/else step used to support exactly one `<value> op <value>`
 * comparison of numbers or text. Real rules need more than that: dates
 * ("close date is before today"), several conditions together ("amount is
 * 50,000 or more AND no activity for 14 days"), empty values, and values
 * computed from others (days between two dates, a due date three business
 * days out, a total over a list). Without them the designer could not put
 * a rule on the canvas and fell back to one AI node doing everything.
 *
 * Inside {! … }:
 *   a path                    deal.CloseDate, recordId, deals.count
 *   TODAY                     today's date, yyyy-mm-dd (UTC)
 *   ADD_DAYS(date, n)         ADD_BUSINESS_DAYS(date, n)   ADD_MONTHS(date, n)
 *   DAYS_BETWEEN(from, to)    whole days from `from` to `to` (negative if earlier)
 *   YEAR(date)                FORMAT_NUMBER(n)  → 120,000 (thousands separators, no decimals)
 *   COUNT(list)               SUM(list, 'Field')
 * Arguments are paths, numbers, 'quoted text', TODAY, or other functions.
 *
 * A condition is clauses joined by AND / OR (AND binds first). A clause is
 *   <a> == != > < >= <= <b>     dates, numbers or text, compared as what they are
 *   <a> contains <b>            text, any case
 *   <a> is blank | is not blank
 * Each side is text with {! … } tokens in it, or a 'quoted' literal.
 */
export type Resolve = (path: string) => unknown;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function toDate(v: unknown): Date | null {
  if (v == null || v === '') return null;
  const s = String(v).slice(0, 10);
  if (!ISO_DATE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
const ymd = (d: Date) => d.toISOString().slice(0, 10);

function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}
function addBusinessDays(d: Date, n: number): Date {
  let out = new Date(d.getTime());
  const step = n >= 0 ? 1 : -1;
  let left = Math.abs(n);
  while (left > 0) {
    out = addDays(out, step);
    const wd = out.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return out;
}
function addMonths(d: Date, n: number): Date {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last)));
}

// ── Tokens: {! path } or {! FUNC(args) } ─────────────────────────────

export const FUNCTIONS = ['TODAY', 'ADD_DAYS', 'ADD_BUSINESS_DAYS', 'ADD_MONTHS', 'DAYS_BETWEEN', 'YEAR', 'FORMAT_NUMBER', 'COUNT', 'SUM'] as const;
const FN_RE = new RegExp(`^(${FUNCTIONS.join('|')})\\s*\\((.*)\\)$`, 's');

/** Split a function's arguments on top-level commas. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = '', cur = '';
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The value of what is inside {! … }. */
export function evaluateToken(expr: string, resolve: Resolve): unknown {
  const e = expr.trim();
  if (e === 'TODAY' || e === 'TODAY()') return today();
  if (/^'.*'$|^".*"$/s.test(e)) return e.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
  const fn = FN_RE.exec(e);
  if (!fn) return resolve(e);
  const args = splitArgs(fn[2]).map(a => evaluateToken(a, resolve));
  const num = (v: unknown) => (v == null || v === '' ? NaN : Number(v));
  switch (fn[1]) {
    case 'TODAY': return today();
    case 'ADD_DAYS': { const d = toDate(args[0]); return d ? ymd(addDays(d, num(args[1]) || 0)) : null; }
    case 'ADD_BUSINESS_DAYS': { const d = toDate(args[0]); return d ? ymd(addBusinessDays(d, num(args[1]) || 0)) : null; }
    case 'ADD_MONTHS': { const d = toDate(args[0]); return d ? ymd(addMonths(d, num(args[1]) || 0)) : null; }
    case 'DAYS_BETWEEN': {
      const a = toDate(args[0]), b = toDate(args[1]);
      return a && b ? Math.round((b.getTime() - a.getTime()) / 86_400_000) : null;
    }
    case 'YEAR': { const d = toDate(args[0]); return d ? d.getUTCFullYear() : null; }
    case 'FORMAT_NUMBER': { const n = num(args[0]); return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : ''; }
    case 'COUNT': return Array.isArray(args[0]) ? args[0].length : args[0] == null ? 0 : 1;
    case 'SUM': {
      const list = Array.isArray(args[0]) ? args[0] : [];
      const field = String(args[1] ?? '');
      return list.reduce((t: number, r) => {
        const v = field && r && typeof r === 'object' ? (r as Record<string, unknown>)[field] : r;
        const n = Number(v);
        return Number.isFinite(n) ? t + n : t;
      }, 0);
    }
  }
  return null;
}

/** Text with every {! … } token filled in; an empty value becomes ''. */
export function interpolateText(template: string, resolve: Resolve): string {
  if (!template) return template;
  return template.replace(/\{!((?:[^{}]|\{[^{}]*\})+)\}/g, (_m, inner: string) => {
    const v = evaluateToken(inner, resolve);
    return v == null ? '' : String(v);
  });
}

/** The paths a token reads (for "is this defined earlier" checks), function names and literals left out. */
export function tokenPaths(expr: string): string[] {
  const out: string[] = [];
  const stripped = expr.replace(/'[^']*'|"[^"]*"/g, ' ');
  for (const m of stripped.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*/g)) {
    const word = m[0];
    const after = stripped.slice((m.index ?? 0) + word.length).trimStart();
    if ((FUNCTIONS as readonly string[]).includes(word) && (after.startsWith('(') || word === 'TODAY')) continue;
    if (/^(AND|OR)$/i.test(word)) continue;
    out.push(word);
  }
  return out;
}

// ── Conditions ───────────────────────────────────────────────────────

/** Split on a separator word outside quotes and outside {! … }. */
function splitOutside(s: string, sep: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0, quote = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0) {
      const m = sep.exec(s.slice(i));
      if (m && m.index === 0) { parts.push(s.slice(start, i)); i += m[0].length - 1; start = i + 1; }
    }
  }
  parts.push(s.slice(start));
  return parts.map(p => p.trim()).filter(p => p.length > 0);
}

const OPS = ['is not blank', 'is blank', 'contains', '>=', '<=', '!=', '==', '>', '<'];

/** Where the clause's operator is, outside tokens and quotes. */
function findOperator(clause: string): { op: string; at: number } | null {
  let depth = 0, quote = '';
  for (let i = 0; i < clause.length; i++) {
    const ch = clause[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth !== 0) continue;
    for (const op of OPS) {
      const word = /^[a-z]/.test(op);
      if (clause.slice(i, i + op.length).toLowerCase() !== op) continue;
      if (word && (i === 0 || !/\s/.test(clause[i - 1]))) continue;
      return { op, at: i };
    }
  }
  return null;
}

function valueOf(side: string, resolve: Resolve): unknown {
  const s = side.trim();
  const whole = /^\{!((?:[^{}]|\{[^{}]*\})+)\}$/.exec(s);
  if (whole) return evaluateToken(whole[1], resolve);
  if (/^'.*'$|^".*"$/s.test(s)) return s.slice(1, -1);
  return interpolateText(s, resolve);
}

function compare(a: unknown, op: string, b: unknown): boolean {
  const blank = (v: unknown) => v == null || String(v).trim() === '';
  if (op === 'is blank') return blank(a);
  if (op === 'is not blank') return !blank(a);
  if (op === 'contains') return !blank(a) && String(a).toLowerCase().includes(String(b ?? '').toLowerCase());
  const as = a == null ? '' : String(a).trim(), bs = b == null ? '' : String(b).trim();
  let x: number | string, y: number | string;
  const da = toDate(as), db = toDate(bs);
  if (da && db) { x = da.getTime(); y = db.getTime(); }
  else if (as !== '' && bs !== '' && Number.isFinite(Number(as)) && Number.isFinite(Number(bs))) { x = Number(as); y = Number(bs); }
  else if (as.toLowerCase() === 'true' || as.toLowerCase() === 'false') { x = as.toLowerCase(); y = bs.toLowerCase(); }
  else { x = as; y = bs; }
  switch (op) {
    case '==': return x === y;
    case '!=': return x !== y;
    // An empty side never satisfies an ordering: "no date" is not "before today".
    case '>': return as !== '' && bs !== '' && x > y;
    case '<': return as !== '' && bs !== '' && x < y;
    case '>=': return as !== '' && bs !== '' && x >= y;
    case '<=': return as !== '' && bs !== '' && x <= y;
  }
  return false;
}

/** Evaluate a condition; unknown shapes are false, never an exception. */
export function evaluateCondition(condition: string, resolve: Resolve): boolean {
  const c = (condition ?? '').trim();
  if (!c) return false;
  return splitOutside(c, /^\s+(OR|\|\|)\s+/i).some(group =>
    splitOutside(group, /^\s+(AND|&&)\s+/i).every(clause => {
      const f = findOperator(clause);
      if (!f) {
        const v = valueOf(clause, resolve);
        return v === true || String(v).toLowerCase() === 'true';
      }
      const left = clause.slice(0, f.at);
      const right = clause.slice(f.at + f.op.length);
      return compare(valueOf(left, resolve), f.op, f.op.startsWith('is ') ? null : valueOf(right, resolve));
    }),
  );
}

/** Whether a condition has the shape the evaluator understands (for design-time checks). */
export function conditionProblems(condition: string): string[] {
  const c = (condition ?? '').trim();
  if (!c) return ['empty condition'];
  const problems: string[] = [];
  for (const group of splitOutside(c, /^\s+(OR|\|\|)\s+/i)) {
    for (const clause of splitOutside(group, /^\s+(AND|&&)\s+/i)) {
      const f = findOperator(clause);
      if (!f) problems.push(`"${clause}" has no comparison (== != > < >= <= contains, is blank, is not blank)`);
      else if (!f.op.startsWith('is ') && !clause.slice(f.at + f.op.length).trim()) problems.push(`"${clause}" has nothing after ${f.op}`);
      else if (!clause.slice(0, f.at).trim()) problems.push(`"${clause}" has nothing before ${f.op}`);
    }
  }
  return problems;
}

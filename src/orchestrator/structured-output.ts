/**
 * STRUCTURED OUTPUT FOR AI STEPS — the model's answer as named fields that
 * later steps and conditions read, like n8n's Structured Output Parser /
 * Information Extractor.
 *
 * An AI step declares its outputs:
 *   mood:   choice  interested | cooling off | blocked | no reply   — the customer's state
 *   risk:   number  0-100
 *   reason: text    one sentence, the facts used
 *   due:    date
 *   urgent: boolean
 * The model is told to answer with ONLY a JSON object of those fields; the
 * answer is parsed, each field checked and coerced to its type (a choice
 * must be one of its options, a number a number, a date YYYY-MM-DD), and
 * the fields are recorded on the step, so {!judge.mood} == 'blocked' can
 * branch. An answer that does not fit is sent back once with what was
 * wrong; a second miss fails the step with the reason, never a guess.
 */
export type OutputType = 'text' | 'number' | 'boolean' | 'date' | 'choice';

export interface OutputField {
  name: string;
  type: OutputType;
  description?: string;
  options?: string[];
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const TYPES: OutputType[] = ['text', 'number', 'boolean', 'date', 'choice'];

/**
 * One field from the short form a designer writes: "choice: a | b | c —
 * what it means", "number: 0-100 risk", "text: one-line reason", "date",
 * "boolean: …". A bare description is text.
 */
export function parseFieldSpec(name: string, spec: string): OutputField | string {
  if (!NAME_RE.test(name)) return `output name "${name}" must be letters, digits and _ only, starting with a letter`;
  const s = String(spec ?? '').trim();
  const m = /^(text|number|boolean|date|choice)\s*(?::\s*(.*))?$/is.exec(s);
  if (!m) return { name, type: 'text', description: s || undefined };
  const type = m[1].toLowerCase() as OutputType;
  const rest = (m[2] ?? '').trim();
  if (type !== 'choice') return { name, type, description: rest || undefined };
  const [optsPart, ...desc] = rest.split(/\s+[—-]\s+/);
  const options = optsPart.split('|').map(o => o.trim()).filter(Boolean);
  if (options.length < 2) return `output "${name}" is a choice and needs at least two options, like "choice: yes | no"`;
  return { name, type, options, description: desc.join(' - ') || undefined };
}

/** Outputs from node config, whichever shape it was saved in. */
export function normalizeOutputs(raw: unknown): OutputField[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && typeof (f as { name?: unknown }).name === 'string')
      .map(f => ({
        name: String(f.name).trim(),
        type: (TYPES.includes(f.type as OutputType) ? f.type : 'text') as OutputType,
        description: typeof f.description === 'string' && f.description.trim() ? f.description.trim() : undefined,
        options: Array.isArray(f.options) ? (f.options as unknown[]).map(String).map(o => o.trim()).filter(Boolean) : undefined,
      }))
      .filter(f => NAME_RE.test(f.name));
  }
  if (raw && typeof raw === 'object') {
    const out: OutputField[] = [];
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const f = parseFieldSpec(k, String(v ?? ''));
      if (typeof f !== 'string') out.push(f);
    }
    return out;
  }
  return [];
}

/** What the model is told to return. */
export function outputInstruction(fields: OutputField[]): string {
  const lines = fields.map(f => {
    const kind = f.type === 'choice'
      ? `exactly one of ${f.options!.map(o => JSON.stringify(o)).join(', ')}`
      : f.type === 'number' ? 'a number' : f.type === 'boolean' ? 'true or false' : f.type === 'date' ? 'a date as "YYYY-MM-DD"' : 'text';
    return `  "${f.name}": ${kind}${f.description ? ` — ${f.description}` : ''}`;
  });
  return '\n\nANSWER FORMAT: reply with ONLY one JSON object — no prose before or after, no code fence — with exactly these fields:\n{\n' +
    lines.join(',\n') + '\n}';
}

/** The first JSON object in a reply, tolerating a code fence or text around it. */
function extractJson(text: string): Record<string, unknown> | null {
  const t = (text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0, quote = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (quote) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') quote = false; continue; }
    if (ch === '"') quote = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { const v = JSON.parse(t.slice(start, i + 1)); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
    }
  }
  return null;
}

/** The declared fields, checked and coerced; `problems` says what did not fit. */
export function parseOutputs(text: string, fields: OutputField[]): { values: Record<string, unknown>; problems: string[] } {
  const obj = extractJson(text);
  if (!obj) return { values: {}, problems: ['the answer was not a JSON object'] };
  const values: Record<string, unknown> = {};
  const problems: string[] = [];
  const lower = new Map(Object.keys(obj).map(k => [k.toLowerCase(), k]));
  for (const f of fields) {
    const key = f.name in obj ? f.name : lower.get(f.name.toLowerCase());
    const v = key === undefined ? undefined : obj[key];
    if (v === undefined || v === null || v === '') { problems.push(`"${f.name}" is missing`); continue; }
    switch (f.type) {
      case 'number': {
        const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s%$]/g, ''));
        if (Number.isFinite(n)) values[f.name] = n; else problems.push(`"${f.name}" must be a number, got ${JSON.stringify(v)}`);
        break;
      }
      case 'boolean': {
        const s = String(v).toLowerCase();
        if (v === true || s === 'true' || s === 'yes') values[f.name] = true;
        else if (v === false || s === 'false' || s === 'no') values[f.name] = false;
        else problems.push(`"${f.name}" must be true or false, got ${JSON.stringify(v)}`);
        break;
      }
      case 'date': {
        const s = String(v).slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))) values[f.name] = s;
        else problems.push(`"${f.name}" must be a date like 2026-09-30, got ${JSON.stringify(v)}`);
        break;
      }
      case 'choice': {
        const hit = f.options!.find(o => o.toLowerCase() === String(v).trim().toLowerCase());
        if (hit) values[f.name] = hit; else problems.push(`"${f.name}" must be one of ${f.options!.join(' | ')}, got ${JSON.stringify(v)}`);
        break;
      }
      default:
        values[f.name] = typeof v === 'string' ? v : JSON.stringify(v);
    }
  }
  return { values, problems };
}

/**
 * redact — strip secrets before anything reaches the trace store.
 *
 * This is the one module in the tracing path that must not be wrong. A
 * trace records the exact body sent to a provider and the exact body that
 * came back, across EVERY tenant, into one table support staff read. The
 * same objects that carry those bodies also carry credentials: the per-org
 * provider key (engineOverride.apiKey), the Salesforce access token handed
 * to MCP servers, and the install's SessionKey. Persisting any of them
 * would turn a debugging aid into a credential store.
 *
 * Two passes, because either alone leaks:
 *
 *   BY KEY   — anything NAMED like a secret is replaced wholesale, however
 *              deeply nested, whatever its value looks like.
 *   BY SHAPE — free text is scanned for credential patterns, because a key
 *              also arrives inside URLs, header strings and error messages
 *              where no field name is there to protect it.
 *
 * Fails closed: an unrecognised object with a secret-shaped key is
 * redacted rather than kept.
 */

export const REDACTED = '[redacted]';

/** Field names whose VALUE is always a secret. Matched case-insensitively
 *  and as a substring, so `sfAccessToken` and `X-Api-Key` both hit. */
const SECRET_KEY_RE =
  /(api[-_]?key|apikey|secret|passwo?rd|authorization|auth[-_]?token|access[-_]?token|refresh[-_]?token|session[-_]?key|sessionkey|bearer|credential|private[-_]?key|client[-_]?secret|signature)/i;

/** Credential shapes that can appear inside otherwise ordinary text. */
const VALUE_PATTERNS: RegExp[] = [
  // OpenAI-style keys, including the sk-ant- and project-scoped variants.
  /\b(?:sk|pk|rk)-(?:[A-Za-z0-9]+-)?[A-Za-z0-9_-]{16,}/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  // Salesforce session id: 00D…!… — the bang is the giveaway.
  /\b00[A-Za-z0-9]{12,16}![A-Za-z0-9._-]{10,}/g,
  // Anything presented as a bearer credential.
  /\bBearer\s+[A-Za-z0-9._-]{12,}/gi,
  // JWTs.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** Scrub credential shapes out of free text. */
export function redactText(input: string): string {
  let out = input;
  for (const re of VALUE_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }
  return out;
}

/**
 * Deep-clone a value with every secret removed.
 *
 * `maxChars` caps any single string — a trace is for diagnosis, not
 * archival, and one runaway tool result should not define the row size.
 * Cycles are broken rather than throwing: this runs on the post-response
 * path and must never be the thing that fails.
 */
export function redact(value: unknown, maxChars = 20_000, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    const scrubbed = redactText(value);
    return scrubbed.length > maxChars
      ? `${scrubbed.slice(0, maxChars)}…[+${scrubbed.length - maxChars} chars]`
      : scrubbed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[circular]';
    seen.add(value as object);

    if (Array.isArray(value)) return value.map(v => redact(v, maxChars, seen));
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
    // Exotic containers: record their shape, not their guts.
    if (value instanceof Map) return { '[Map]': redact(Object.fromEntries(value), maxChars, seen) };
    if (value instanceof Set) return { '[Set]': redact([...value], maxChars, seen) };

    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      // Fails closed: the NAME alone is enough, whatever the value is.
      out[key] = SECRET_KEY_RE.test(key) ? REDACTED : redact(v, maxChars, seen);
    }
    return out;
  }
  return undefined;
}

/** Redacted, JSON-safe and bounded as a whole, so one pathological payload
 *  cannot bloat a row. Returns a marker object rather than throwing when a
 *  value will not serialize. */
export function redactForStorage(value: unknown, maxTotalChars = 200_000): unknown {
  const cleaned = redact(value);
  let json: string | undefined;
  try {
    json = JSON.stringify(cleaned);
  } catch {
    return { unserializable: true };
  }
  if (json && json.length > maxTotalChars) {
    return { truncated: true, chars: json.length, preview: json.slice(0, maxTotalChars) };
  }
  return cleaned;
}

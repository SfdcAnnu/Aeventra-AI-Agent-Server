/**
 * output-guardrails — UNIVERSAL customer-facing reply protections. Nothing
 * in this file is use-case-, agent-, org-, or field-specific; use-case
 * behavior lives in agent data (prompts, KB, node configs), never in
 * server code.
 *
 * Armed per agent by ONE flag on the root AI node's ConfigJson:
 * `customerFacing: true`. What it enforces:
 *
 *  1. Action-claim guard: a reply that claims/promises something was
 *     booked, registered, or updated with ZERO successful write-tool calls
 *     this turn is a fabrication — graph-runtime forces corrective passes
 *     with tools live (debug-verified failure: "your call is booked", no
 *     tool calls).
 *  2. Internal-language filter: internal vocabulary and CRM/system
 *     narration never reach a customer — one corrective regeneration, then
 *     a mechanical scrub. Per-agent extra phrases come from
 *     `bannedPhrases` in the same config.
 */

export interface GuardrailsConfig {
  customerFacing: boolean;
  bannedPhrases: string[];
}

/** Parse the root AI node's ConfigJson. Unknown/invalid entries are
 *  ignored rather than erroring. */
export function readGuardrailsConfig(nodeConfig: unknown): GuardrailsConfig {
  const cfg = (nodeConfig ?? {}) as { customerFacing?: unknown; bannedPhrases?: unknown; guardrails?: { bannedPhrases?: unknown } };
  const rawPhrases = Array.isArray(cfg.bannedPhrases)
    ? cfg.bannedPhrases
    : Array.isArray(cfg.guardrails?.bannedPhrases) ? cfg.guardrails.bannedPhrases : [];
  return {
    customerFacing: cfg.customerFacing === true,
    bannedPhrases: rawPhrases.filter((p): p is string => typeof p === 'string' && p.trim().length > 1).slice(0, 50),
  };
}

// ── Action-claim guardrail ───────────────────────────────────────────

export const WRITE_TOOL_NAMES = new Set([
  'createSobjectRecord',
  'updateSobjectRecord',
  'updateRelatedRecord',
  'bulkUpdateSobjectRecords',
]);

const COMPLETED_CLAIM_RE =
  /\b(?:i(?:'|’)?ve|i\s+have|has\s+been|have\s+been|is\s+now|are\s+now)\s+(?:successfully\s+|officially\s+|now\s+)?(?:scheduled|booked|arranged|registered|logged|created|updated|recorded|set(?:\s+up)?)\b|\byour\s+(?:request|case|meeting|call)\s+is\s+(?:registered|booked|scheduled|logged|confirmed)\b/i;

const WRITE_PROMISE_RE =
  /\b(?:let\s+me|i(?:'|’)ll|i\s+will|i\s+am\s+going\s+to|going\s+to)\s+(?:update|register|log|record|note|create|book|schedule)\b/i;

/** True when the reply asserts or promises a system action. */
export function findActionClaim(text: string): string | null {
  const m = COMPLETED_CLAIM_RE.exec(text) ?? WRITE_PROMISE_RE.exec(text);
  return m ? m[0] : null;
}

export const ACTION_CLAIM_CORRECTION =
  'STOP — your reply claims or promises that something was registered, booked, or updated, but no record was created ' +
  'or updated THIS turn. Claims must NEVER precede the real action. Resolve it now, in this order: ' +
  '(1) If the action was already completed EARLIER in this conversation (you can see its tool results in the ' +
  'transcript), simply restate the confirmation naturally. ' +
  '(2) If your procedure requires asking the customer something first (like their preferred meeting time), ask that ' +
  'question instead — no claims. ' +
  '(3) Otherwise perform the required actions RIGHT NOW with your tools, following your own instructions for this ' +
  'situation — look up any real Ids you need first; never pass placeholder values. Do not transfer to anyone else. ' +
  'THIS RESPONSE MUST CONTAIN TOOL CALLS, not another promise — any "let me…" / "I\'ll…" sentence without tool calls ' +
  'is a repeat of the same violation. ' +
  'Then reply to the customer in their language confirming ONLY what is actually done. If a tool fails, say the team ' +
  'will confirm shortly — never claim success.';

// ── Internal-language filter ─────────────────────────────────────────

/** Generic internal sales/negotiation vocabulary no customer-facing agent
 *  should emit, replaced in place by scrubReply(). Per-agent additions
 *  come from the bannedPhrases config. */
const PHRASE_FIXES: Array<{ re: RegExp; fix: string }> = [
  { re: /\bconcessions?\b/gi, fix: 'offer' },
  { re: /\b(?:price|pricing)\s+floor\b/gi, fix: 'best price' },
  { re: /\bfloor\s+price\b/gi, fix: 'best price' },
  { re: /\bself[-\s]approved\b/gi, fix: 'approved' },
  { re: /\bdiscount\s+(?:matrix|ladder)\b/gi, fix: 'pricing' },
  { re: /\b(?:maximum|max)\s+discount\b/gi, fix: 'best discount' },
  { re: /\bpolicy\s+limits?\b/gi, fix: 'approval level' },
  { re: /\b(?:as\s+per|per|according\s+to)\s+(?:our|company|internal)\s+policy\b/gi, fix: 'at my level' },
  { re: /\binternal\s+(?:limits?|thresholds?|caps?|policy|policies)\b/gi, fix: 'my approval level' },
];

/** CRM/system narration a customer must never see — whole sentence dropped. */
const SENTENCE_DROP: RegExp[] = [
  /\bCRM\b/,
  /\bsalesforce\b/i,
  /\bopportunity\s+stage\b/i,
  /\b(?:updated?|creat(?:ed|ing)|logg(?:ed|ing))\b[^.!?\n]*\b(?:record|task|event|opportunity|system|database)s?\b/i,
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter(s => s.trim().length > 0);
}

/** Human-readable violation labels — empty array means the reply is clean. */
export function findGuardrailViolations(text: string, extraPhrases: string[] = []): string[] {
  const violations: string[] = [];
  for (const { re } of PHRASE_FIXES) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) violations.push(`internal vocabulary "${m[0]}"`);
  }
  for (const phrase of extraPhrases) {
    const m = new RegExp(`\\b${escapeRe(phrase)}\\b`, 'i').exec(text);
    if (m) violations.push(`banned phrase "${m[0]}"`);
  }
  for (const re of SENTENCE_DROP) {
    const m = re.exec(text);
    if (m) violations.push(`CRM-internal narration "${m[0]}"`);
  }
  return violations;
}

/** Mechanical last resort after a failed regeneration: swap internal
 *  vocabulary and drop CRM-internal sentences. Never returns an empty
 *  string — falls back to the original text. */
export function scrubReply(text: string, extraPhrases: string[] = []): string {
  let out = text;
  for (const { re, fix } of PHRASE_FIXES) {
    re.lastIndex = 0;
    out = out.replace(re, fix);
  }
  for (const phrase of extraPhrases) {
    out = out.replace(new RegExp(`\\b${escapeRe(phrase)}\\b`, 'gi'), '');
  }
  const kept = splitSentences(out).filter(s => !SENTENCE_DROP.some(re => re.test(s)));
  if (kept.length > 0) out = kept.join(' ');
  return out.trim().length > 0 ? out.trim() : text;
}

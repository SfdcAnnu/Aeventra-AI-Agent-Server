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

/** One in-place rewrite: say `to` instead of `from`. */
export interface PhraseReplacement {
  from: string;
  to: string;
}

export interface GuardrailsConfig {
  customerFacing: boolean;
  bannedPhrases: string[];
  /** Vocabulary this agent should not say, with what to say instead.
   *  Supplied entirely by agent data — the platform ships none, because
   *  what counts as internal jargon depends on the business, not on us. */
  phraseReplacements: PhraseReplacement[];
}

/** Parse the root AI node's ConfigJson. Unknown/invalid entries are
 *  ignored rather than erroring. */
export function readGuardrailsConfig(nodeConfig: unknown): GuardrailsConfig {
  const cfg = (nodeConfig ?? {}) as {
    customerFacing?: unknown;
    bannedPhrases?: unknown;
    phraseReplacements?: unknown;
    guardrails?: { bannedPhrases?: unknown; phraseReplacements?: unknown };
  };
  const rawPhrases = Array.isArray(cfg.bannedPhrases)
    ? cfg.bannedPhrases
    : Array.isArray(cfg.guardrails?.bannedPhrases) ? cfg.guardrails.bannedPhrases : [];
  const rawReplacements = Array.isArray(cfg.phraseReplacements)
    ? cfg.phraseReplacements
    : Array.isArray(cfg.guardrails?.phraseReplacements) ? cfg.guardrails.phraseReplacements : [];
  return {
    customerFacing: cfg.customerFacing === true,
    bannedPhrases: rawPhrases.filter((p): p is string => typeof p === 'string' && p.trim().length > 1).slice(0, 50),
    phraseReplacements: rawReplacements
      .filter((r): r is PhraseReplacement =>
        !!r && typeof (r as PhraseReplacement).from === 'string' &&
        typeof (r as PhraseReplacement).to === 'string' &&
        (r as PhraseReplacement).from.trim().length > 1)
      .slice(0, 50),
  };
}

// ── Action-claim guardrail ───────────────────────────────────────────

export const WRITE_TOOL_NAMES = new Set([
  'createSobjectRecord',
  'updateSobjectRecord',
  'updateRelatedRecord',
  'bulkUpdateSobjectRecords',
]);

/** True when a tool name denotes a WRITE. Custom Apex/Flow actions
 *  (apex__/flow__) and the prebuilt create/update actions (do_*) count —
 *  they exist to perform writes.
 *
 *  Shared deliberately: the action-claim guard uses it to decide whether a
 *  reply may assert something happened, and the session result cache uses
 *  it to decide what must never be served from cache (and what invalidates
 *  it). Those two must never disagree about what a write is. */
export function isWriteToolName(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name) ||
    name.startsWith('apex__') || name.startsWith('flow__') || name.startsWith('do_');
}

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

/**
 * Vocabulary rewrites are AGENT DATA, not platform code.
 *
 * This list used to be hard-coded with sales-negotiation terms — floor
 * price, discount matrix, concessions. That shipped one business's
 * vocabulary to every tenant: a clinic booking appointments or a carrier
 * tracking shipments carried sales rules it could never trigger, and any
 * org whose jargon differed had no way to say so. What counts as internal
 * language depends on the business, so the business supplies it, through
 * the root node's `phraseReplacements` config.
 */
function replacementRules(replacements: PhraseReplacement[]): Array<{ re: RegExp; fix: string }> {
  return replacements.map(r => ({ re: new RegExp(`\b${escapeRe(r.from)}\b`, 'gi'), fix: r.to }));
}

/**
 * THERE IS NO BUILT-IN VOCABULARY LIST, deliberately.
 *
 * One used to live here: CRM, salesforce, "opportunity stage", and a
 * pattern for record/task/system narration. It survived the cleanup that
 * removed this server's other business logic, on the reasoning that it was
 * a "universal customer-facing protection". It was not. It was ONE
 * customer's vocabulary -- a WhatsApp sales agent whose buyers should never
 * hear CRM jargon -- compiled into the platform every other agent runs on.
 *
 * What it cost: an INTERNAL assistant for account executives, people who
 * work in Salesforce all day, could not say the word "Salesforce". Every
 * reply mentioning it was silently regenerated, so the model's answer and
 * the customer's answer differed with nothing in the trace explaining why,
 * and a second model call was billed on turns that needed none.
 *
 * Which words an agent may not say is a property of THAT AGENT'S AUDIENCE,
 * and only its author knows it. So it comes from the agent's own config
 * (bannedPhrases / phraseReplacements, set on the Guardrails screen) and
 * from nowhere else. An agent that configures nothing is filtered by
 * nothing.
 *
 * The action-claim guard below stays, because it IS universal: a reply
 * asserting a write that no write tool performed is false for every agent
 * in every domain. That is a statement about this runtime, not about
 * anyone's vocabulary.
 */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter(s => s.trim().length > 0);
}

/** Human-readable violation labels — empty array means the reply is clean. */
export function findGuardrailViolations(
  text: string,
  extraPhrases: string[] = [],
  replacements: PhraseReplacement[] = [],
): string[] {
  const violations: string[] = [];
  for (const { re } of replacementRules(replacements)) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) violations.push(`internal vocabulary "${m[0]}"`);
  }
  for (const phrase of extraPhrases) {
    const m = new RegExp(`\\b${escapeRe(phrase)}\\b`, 'i').exec(text);
    if (m) violations.push(`banned phrase "${m[0]}"`);
  }
  return violations;
}

/** Mechanical last resort after a failed regeneration: swap internal
 *  vocabulary and drop CRM-internal sentences. Never returns an empty
 *  string — falls back to the original text. */
export function scrubReply(
  text: string,
  extraPhrases: string[] = [],
  replacements: PhraseReplacement[] = [],
): string {
  let out = text;
  for (const { re, fix } of replacementRules(replacements)) {
    re.lastIndex = 0;
    out = out.replace(re, fix);
  }
  for (const phrase of extraPhrases) {
    out = out.replace(new RegExp(`\\b${escapeRe(phrase)}\\b`, 'gi'), '');
  }
  // A configured banned phrase takes the SENTENCE carrying it: a reply
  // with the word cut out mid-clause reads worse than one a sentence short.
  if (extraPhrases.length > 0) {
    const banned = extraPhrases.map(p => new RegExp(`\b${escapeRe(p)}\b`, 'i'));
    const kept = splitSentences(out).filter(sentence => !banned.some(re => re.test(sentence)));
    if (kept.length > 0) out = kept.join(' ');
  }
  return out.trim().length > 0 ? out.trim() : text;
}

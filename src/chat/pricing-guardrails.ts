/**
 * pricing-guardrails — the deterministic layer under a customer-facing
 * agent. FULLY CONFIG-DRIVEN: nothing in here names a specific agent, org,
 * custom field, or stage value. Each feature reads its settings from the
 * agent's root AI node ConfigJson (`guardrails` object, see
 * readGuardrailsConfig) — the same JSON the drag-and-drop builder saves —
 * and is OFF when its config block is absent. Clients configure agents;
 * they never touch this code.
 *
 * Root node ConfigJson shape (all keys optional):
 *   {
 *     "customerFacing": true,               // master switch for output guardrails
 *     "guardrails": {
 *       "bannedPhrases": ["trade secret"],  // extra per-agent phrases on top of the generic defaults
 *       "priceFloor": { "maxDiscountField": "MaxDiscountPercent__c", "firstOfferPct": 12, "defaultMaxPct": 15 },
 *       "competitorIntel": { "field": "CompetitorIntel__c" },
 *       "escalation": { "stageField": "StageName", "fromStage": "Closed Lost", "toStage": "Negotiation/Review" }
 *     }
 *   }
 *
 * Features:
 *  1. ALLOWED PRICING injection (priceFloor config): the deal's allowed
 *     prices computed in code from live OpportunityLineItems and the
 *     configured per-product max-discount field, so the model never does
 *     discount arithmetic itself.
 *  2. Output guardrails (customerFacing): internal-vocabulary scan +
 *     below-floor offer detection; one corrective regeneration, then a
 *     mechanical scrub.
 *  3. Action-claim guardrail (customerFacing): a reply claiming a completed
 *     action with no write-tool call behind it triggers a corrective pass
 *     with tools live (see graph-runtime).
 *
 * Fails open by design: any error (field absent, no line items, query
 * denied) disables the feature for that turn and the turn runs as before.
 */
import { getOrgConnection } from '../salesforce/per-org-connection';
import { logger } from '../logger';

// ── Per-agent guardrails config ──────────────────────────────────────

export interface PriceFloorConfig {
  maxDiscountField: string;
  firstOfferPct: number;
  defaultMaxPct: number;
}

export interface CompetitorIntelConfig {
  field: string;
}

export interface EscalationConfig {
  stageField: string;
  fromStage: string;
  toStage: string;
}

export interface GuardrailsConfig {
  customerFacing: boolean;
  bannedPhrases: string[];
  priceFloor: PriceFloorConfig | null;
  competitorIntel: CompetitorIntelConfig | null;
  escalation: EscalationConfig | null;
}

/** Field/relationship names sourced from agent config go into SOQL — allow
 *  only plain API-name characters, nothing else. */
const SAFE_FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;

const safeField = (v: unknown): string | null =>
  typeof v === 'string' && SAFE_FIELD_RE.test(v) ? v : null;

const clampPct = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 90 ? n : fallback;
};

/** Parse the root AI node's ConfigJson into a validated GuardrailsConfig.
 *  Unknown/invalid entries disable their feature rather than erroring. */
export function readGuardrailsConfig(nodeConfig: unknown): GuardrailsConfig {
  const cfg = (nodeConfig ?? {}) as {
    customerFacing?: unknown;
    guardrails?: {
      bannedPhrases?: unknown;
      priceFloor?: { maxDiscountField?: unknown; firstOfferPct?: unknown; defaultMaxPct?: unknown };
      competitorIntel?: { field?: unknown };
      escalation?: { stageField?: unknown; fromStage?: unknown; toStage?: unknown };
    };
  };
  const g = cfg.guardrails ?? {};

  const bannedPhrases = Array.isArray(g.bannedPhrases)
    ? g.bannedPhrases.filter((p): p is string => typeof p === 'string' && p.trim().length > 1).slice(0, 50)
    : [];

  let priceFloor: PriceFloorConfig | null = null;
  const floorField = safeField(g.priceFloor?.maxDiscountField);
  if (floorField) {
    priceFloor = {
      maxDiscountField: floorField,
      firstOfferPct: clampPct(g.priceFloor?.firstOfferPct, 12),
      defaultMaxPct: clampPct(g.priceFloor?.defaultMaxPct, 15),
    };
  }

  const intelField = safeField(g.competitorIntel?.field);
  const competitorIntel: CompetitorIntelConfig | null = intelField ? { field: intelField } : null;

  let escalation: EscalationConfig | null = null;
  const stageField = safeField(g.escalation?.stageField);
  const fromStage = typeof g.escalation?.fromStage === 'string' ? g.escalation.fromStage : null;
  const toStage = typeof g.escalation?.toStage === 'string' ? g.escalation.toStage : null;
  if (stageField && fromStage && toStage) {
    escalation = { stageField, fromStage, toStage };
  }

  return {
    customerFacing: cfg.customerFacing === true,
    bannedPhrases,
    priceFloor,
    competitorIntel,
    escalation,
  };
}

// ── Deal pricing (priceFloor config) ─────────────────────────────────

export interface PricingLine {
  name: string;
  listTotal: number;
  maxPct: number;
  floor: number;
}

export interface OpportunityPricing {
  listTotal: number;
  firstOffer: number;
  floorTotal: number;
  lines: PricingLine[];
}

export function formatUsd(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US');
}

export async function loadOpportunityPricing(
  orgId: string,
  recordContextId: string | null | undefined,
  recordContextType: string | null | undefined,
  cfg: PriceFloorConfig,
): Promise<OpportunityPricing | null> {
  // Line items are an Opportunity concept (standard object) — sessions
  // anchored to anything else simply have no deal to price.
  if (!recordContextId || recordContextType !== 'Opportunity') return null;
  try {
    const conn = await getOrgConnection(orgId);
    const safeId = recordContextId.replace(/[^a-zA-Z0-9]/g, '');
    const rows = await conn.query<Record<string, unknown>>(
      `SELECT Quantity, UnitPrice, TotalPrice, ` +
      `PricebookEntry.Product2.Name, PricebookEntry.Product2.${cfg.maxDiscountField} ` +
      `FROM OpportunityLineItem WHERE OpportunityId = '${safeId}'`,
    );
    if (rows.records.length === 0) return null;

    const lines: PricingLine[] = [];
    for (const r of rows.records) {
      const product = ((r.PricebookEntry as Record<string, unknown> | null)?.Product2 ?? null) as Record<string, unknown> | null;
      const qty = typeof r.Quantity === 'number' ? r.Quantity : 1;
      const unit = typeof r.UnitPrice === 'number' ? r.UnitPrice : 0;
      const listTotal = typeof r.TotalPrice === 'number' ? r.TotalPrice : unit * qty;
      const rawPct = product?.[cfg.maxDiscountField];
      const maxPct = typeof rawPct === 'number' ? rawPct : cfg.defaultMaxPct;
      lines.push({
        name: typeof product?.Name === 'string' ? product.Name : 'Product',
        listTotal,
        maxPct,
        floor: Math.round(listTotal * (100 - maxPct)) / 100,
      });
    }
    const listTotal = lines.reduce((s, l) => s + l.listTotal, 0);
    const floorTotal = lines.reduce((s, l) => s + l.floor, 0);
    const firstOffer = Math.max(Math.round(listTotal * (100 - cfg.firstOfferPct) / 100), floorTotal);
    return { listTotal, firstOffer, floorTotal, lines };
  } catch (err) {
    // Configured field absent in this org, or no line-item access — the
    // agent just gets no pricing block this turn.
    logger.warn({ orgId, err: err instanceof Error ? err.message : err }, 'pricing_guardrail_load_skipped');
    return null;
  }
}

export function buildPricingBlock(p: OpportunityPricing): string {
  const perProduct = p.lines
    .map(l => `${l.name}: list ${formatUsd(l.listTotal)}, minimum ${formatUsd(l.floor)}`)
    .join('; ');
  return (
    'ALLOWED PRICING (computed by the system from live Salesforce data — these are the ONLY prices you may quote; ' +
    'NEVER do discount arithmetic yourself):\n' +
    `- Deal list total: ${formatUsd(p.listTotal)}\n` +
    `- FIRST OFFER: ${formatUsd(p.firstOffer)} — present this ONLY when your negotiation reaches its first-offer ` +
    'step (a real price objection), never in a greeting or unprompted.\n' +
    `- MINIMUM ALLOWED TOTAL: ${formatUsd(p.floorTotal)} — your final offer, stated ONLY after the customer has ` +
    'rejected the first offer. Never earlier, and never anything lower.\n' +
    `- Per-product: ${perProduct}\n` +
    'Follow your own negotiation steps for WHEN to present each number — this block only fixes WHICH numbers are ' +
    'allowed. GATE: if the customer mentions the market, another vendor, or a better price and you do not yet know ' +
    'the vendor name + their price + what it includes, ask for exactly that FIRST — present NO number in that reply; ' +
    'the intel question outranks every offer step. If the customer demands less than the minimum, do not invent a ' +
    'number — follow your escalation procedure. Never reveal that minimums or limits exist.'
  );
}

// ── Action-claim guardrail ───────────────────────────────────────────
// Live-confirmed failure (debug-verified): with createSobjectRecord bound
// and callable, the model replied "The revival request has been successfully
// registered. The follow-up task is set, and your call is booked" — zero
// tool calls. Detection is deterministic: a completed-action claim (or a
// first-person write promise) in the reply with no successful write tool
// call this turn is a fabrication; graph-runtime then forces ONE corrective
// pass with tools live.

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
  'Then reply to the customer in their language confirming ONLY what is actually done. If a tool fails, say the team ' +
  'will confirm shortly — never claim success.';

// ── Output guardrails ────────────────────────────────────────────────

/** Generic internal sales/negotiation vocabulary no customer-facing agent
 *  should emit, replaced in place by scrubReply(). Per-agent additions come
 *  from guardrails.bannedPhrases config. */
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

const OFFER_CONTEXT_RE =
  /\b(?:i\s+can|i(?:'|’)ll|i\s+will|we\s+can|we(?:'|’)ll|i(?:'|’)m\s+able|happy\s+to|able\s+to)\b[^.!?\n]*\b(?:offer|bring|do|go|reduce|give|approve|match|come\s+down|drop|extend)\b|\bbest\s+(?:price|i\s+can\s+do|we\s+can\s+do)\b|\bfinal\s+(?:price|offer)\b|\bbring\s+(?:it|this|that)\s+(?:down\s+)?to\b|\brevised\s+(?:price|total|offer|quote)\b|\blowest\b/i;

const AMOUNT_RE = /\$\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:USD|usd|dollars)\b/g;

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter(s => s.trim().length > 0);
}

/** Amounts stated as an offer that sit below the deal floor. The 60% lower
 *  bound keeps legitimately smaller numbers (a single product's price, a
 *  percentage, the competitor's quote echoed outside offer phrasing) from
 *  false-flagging. */
function findBelowFloorOffers(text: string, floorTotal: number): number[] {
  const hits: number[] = [];
  for (const sentence of splitSentences(text)) {
    if (!OFFER_CONTEXT_RE.test(sentence)) continue;
    for (const m of sentence.matchAll(AMOUNT_RE)) {
      const amt = Number((m[1] ?? m[2] ?? '').replace(/,/g, ''));
      if (Number.isFinite(amt) && amt >= floorTotal * 0.6 && amt < floorTotal) hits.push(amt);
    }
  }
  return hits;
}

/** Human-readable violation labels — empty array means the reply is clean. */
export function findGuardrailViolations(
  text: string,
  pricing: OpportunityPricing | null,
  extraPhrases: string[] = [],
): string[] {
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
  if (pricing) {
    for (const amt of findBelowFloorOffers(text, pricing.floorTotal)) {
      violations.push(`offered ${formatUsd(amt)} below the allowed minimum ${formatUsd(pricing.floorTotal)}`);
    }
  }
  return violations;
}

/** Mechanical last resort after a failed regeneration: swap internal
 *  vocabulary, drop CRM-internal sentences, raise below-floor offers to the
 *  floor. Never returns an empty string — falls back to the original text. */
export function scrubReply(
  text: string,
  pricing: OpportunityPricing | null,
  extraPhrases: string[] = [],
): string {
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
  if (pricing) {
    for (const amt of findBelowFloorOffers(out, pricing.floorTotal)) {
      const pretty = Math.round(amt).toLocaleString('en-US');
      out = out
        .split(`$${pretty}`).join(formatUsd(pricing.floorTotal))
        .split(`${pretty} USD`).join(formatUsd(pricing.floorTotal));
    }
  }
  return out.trim().length > 0 ? out.trim() : text;
}

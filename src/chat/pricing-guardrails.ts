/**
 * pricing-guardrails — the deterministic layer under a customer-facing
 * negotiation agent. Two halves:
 *
 *  1. ALLOWED PRICING injection: loadOpportunityPricing() computes the
 *     deal's allowed prices in code — list total, first offer (12% off),
 *     per-product floors from Product2.MaxDiscountPercent__c, and the floor
 *     total — from live OpportunityLineItems. buildPricingBlock() turns that
 *     into a system-prompt block so the model never does discount arithmetic
 *     itself (live-confirmed failure class: a "$50,250 final offer" invented
 *     under pressure, undercutting the real $54,250 floor).
 *
 *  2. Output guardrails: findGuardrailViolations() scans the outgoing reply
 *     for internal negotiation/CRM vocabulary and for a below-floor offer;
 *     graph-runtime gives the model ONE corrective regeneration, then
 *     scrubReply() fixes the text mechanically as a last resort. Enforcement
 *     only runs for agents whose root AI node config carries
 *     `customerFacing: true` — internal/builder agents legitimately talk
 *     about Salesforce records and price floors.
 *
 * Fails open by design: any error here (field absent in this org, no line
 * items, query denied) returns null and the turn runs exactly as before.
 */
import { getOrgConnection } from '../salesforce/per-org-connection';
import { logger } from '../logger';

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

interface LineItemRow {
  Quantity: number | null;
  UnitPrice: number | null;
  TotalPrice: number | null;
  PricebookEntry: {
    Product2: { Name: string; MaxDiscountPercent__c: number | null } | null;
  } | null;
}

const DEFAULT_MAX_PCT = 15;
const FIRST_OFFER_PCT = 12;

export function formatUsd(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US');
}

export async function loadOpportunityPricing(
  orgId: string,
  recordContextId?: string | null,
  recordContextType?: string | null,
): Promise<OpportunityPricing | null> {
  if (!recordContextId || recordContextType !== 'Opportunity') return null;
  try {
    const conn = await getOrgConnection(orgId);
    const rows = await conn.query<LineItemRow>(
      `SELECT Quantity, UnitPrice, TotalPrice, ` +
      `PricebookEntry.Product2.Name, PricebookEntry.Product2.MaxDiscountPercent__c ` +
      `FROM OpportunityLineItem WHERE OpportunityId = '${recordContextId.replace(/[^a-zA-Z0-9]/g, '')}'`,
    );
    if (rows.records.length === 0) return null;

    const lines: PricingLine[] = [];
    for (const r of rows.records) {
      const listTotal = r.TotalPrice ?? ((r.UnitPrice ?? 0) * (r.Quantity ?? 1));
      const maxPct = r.PricebookEntry?.Product2?.MaxDiscountPercent__c ?? DEFAULT_MAX_PCT;
      lines.push({
        name: r.PricebookEntry?.Product2?.Name ?? 'Product',
        listTotal,
        maxPct,
        floor: Math.round(listTotal * (100 - maxPct)) / 100,
      });
    }
    const listTotal = lines.reduce((s, l) => s + l.listTotal, 0);
    const floorTotal = lines.reduce((s, l) => s + l.floor, 0);
    const firstOffer = Math.max(Math.round(listTotal * (100 - FIRST_OFFER_PCT) / 100), floorTotal);
    return { listTotal, firstOffer, floorTotal, lines };
  } catch (err) {
    // The MaxDiscountPercent__c field is a client-org customization — orgs
    // without it (or without line-item access) just get no pricing block.
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
    `- FIRST OFFER (your opening revised price for the full deal): ${formatUsd(p.firstOffer)}\n` +
    `- MINIMUM ALLOWED TOTAL (the absolute lowest full-deal price you may ever state): ${formatUsd(p.floorTotal)}\n` +
    `- Per-product: ${perProduct}\n` +
    'Any price below a minimum is forbidden. If the customer demands less, do not invent a number — follow your ' +
    'escalation procedure. Never reveal that minimums or limits exist.'
  );
}

// ── Action-claim guardrail ───────────────────────────────────────────
// Live-confirmed failure (debug-verified): with createSobjectRecord bound
// and callable, the model replied "The revival request has been successfully
// registered. The follow-up task is set, and your call is booked" — zero
// tool calls. Detection is deterministic: a completed-action claim (or a
// first-person write promise) in the reply with no successful write tool
// call anywhere in the conversation is a fabrication; graph-runtime then
// forces ONE corrective pass with tools live.

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
  'STOP — your reply claims or promises that something was registered, booked, or updated, but NO record has actually ' +
  'been created or updated in this conversation. Claims must NEVER precede the real action. Using your tools RIGHT NOW, ' +
  'perform the actions your instructions require for this situation (for an escalation: update the stage, create the ' +
  'follow-up Task and the Event with the agreed time). Do not transfer to anyone else. Then reply to the customer in ' +
  'their language confirming ONLY what you actually completed. If you are missing information the action needs, ask for ' +
  'it instead of claiming. If a tool fails, say the team will confirm within 24 hours — never claim success.';

// ── Output guardrails ────────────────────────────────────────────────

/** Internal negotiation vocabulary — replaced in place by scrubReply(). */
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

/** CRM internals a customer must never see — whole sentence dropped. */
const SENTENCE_DROP: RegExp[] = [
  /\bCRM\b/,
  /\bsalesforce\b/i,
  /\bopportunity\s+stage\b/i,
  /\bnegotiation\s*\/\s*review\b/i,
  /\b(?:updated?|creat(?:ed|ing)|logg(?:ed|ing))\b[^.!?\n]*\b(?:record|task|event|opportunity|system|database)s?\b/i,
];

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
export function findGuardrailViolations(text: string, pricing: OpportunityPricing | null): string[] {
  const violations: string[] = [];
  for (const { re } of PHRASE_FIXES) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) violations.push(`internal vocabulary "${m[0]}"`);
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
export function scrubReply(text: string, pricing: OpportunityPricing | null): string {
  let out = text;
  for (const { re, fix } of PHRASE_FIXES) {
    re.lastIndex = 0;
    out = out.replace(re, fix);
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

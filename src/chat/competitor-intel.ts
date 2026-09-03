/**
 * Deterministic competitor-intel capture — "code for invariants" for a
 * requirement that prompt instructions satisfied only intermittently
 * (eval-confirmed: the same vendor+price message stored intel on one run
 * and skipped it on the next, depending on whether the agent felt like
 * calling the tool).
 *
 * FULLY CONFIG-DRIVEN: which field to write comes from the agent's
 * guardrails config (`competitorIntel.field`), and the target record is the
 * session's anchored record — nothing here names an agent, org, or field.
 * Agents without the config never run this.
 *
 * After a qualifying customer-facing turn, a cheap regex prefilter checks
 * the USER message for vendor+money signals; on a hit, the org's cheap
 * model extracts {vendor, price, includes} and the SERVER appends the line
 * to the configured field itself via jsforce — no agent tool call involved.
 * Fire-and-forget (memory-summarizer pattern): zero reply latency,
 * fail-open on any error (orgs without the field just log and skip).
 */
import { traceable } from 'langsmith/traceable';
import { logger } from '../logger';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { callCheapModel } from './memory';
import type { EngineOverrideInput } from './adapters/types';

const PREFILTER_MONEY = /(?:\$\s?\d|\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?k\b|\b\d{4,}\b)/i;
const PREFILTER_VENDOR = /\b(?:vendor|competitor|market|another|other|elsewhere|quote\w*|offer\w*|gives?|giving|found|checked|provider|company|cheaper|better\s+price)\b/i;

/** Record/field identifiers reaching SOQL are sanitized here too, even
 *  though readGuardrailsConfig already validated the field name. */
const SAFE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;

const DEFAULT_LISTEN_FOR =
  'The customer references a competing offer — a named vendor, "another vendor", "the market", or "someone else" — ' +
  'with a price or terms.';
const DEFAULT_EXTRACT = ['Vendor', 'Price', 'Includes'];

function buildExtractSystem(listenFor: string, extract: string[]): string {
  const keys = extract.map(e => `"${e}": string|null`).join(', ');
  return (
    'You extract structured information from ONE customer message in a business conversation. ' +
    `Look for: ${listenFor} ` +
    `Reply as JSON: {"found": boolean, ${keys}}. ` +
    'found=true when the message actually contains that information. A NAMED source is NOT required — ' +
    '"I checked the market and can get this for 40k" counts (use "(unnamed)" for the missing name). ' +
    'Normalize amounts to digits (e.g. "40,000" for 40k). Use null for values not present. No commentary — JSON only.'
  );
}

export function maybeStoreCompetitorIntelAsync(args: {
  orgId: string;
  recordId: string;
  recordType: string;
  cfg: { field: string; listenFor?: string; extract?: string[]; keywords?: string[] };
  userMessage: string;
  engineOverride?: EngineOverrideInput | null;
}): void {
  const { orgId, recordId, recordType, cfg, engineOverride } = args;
  const userMessage = args.userMessage;
  if (!engineOverride?.apiKey) return;
  if (!SAFE_NAME_RE.test(cfg.field) || !SAFE_NAME_RE.test(recordType)) return;

  // Prefilter — configured keywords when given, else the built-in
  // vendor+money heuristic. Keeps the cheap-model call off ordinary turns.
  if (cfg.keywords && cfg.keywords.length > 0) {
    const lower = userMessage.toLowerCase();
    if (!cfg.keywords.some(k => lower.includes(k.toLowerCase()))) return;
  } else if (!PREFILTER_MONEY.test(userMessage) || !PREFILTER_VENDOR.test(userMessage)) {
    return;
  }

  const extract = (cfg.extract && cfg.extract.length > 0 ? cfg.extract : DEFAULT_EXTRACT).slice(0, 10);
  const listenFor = cfg.listenFor?.trim() || DEFAULT_LISTEN_FOR;

  void (async () => {
    try {
      const traced = traceable(
        (sys: string, usr: string) => callCheapModel(engineOverride, sys, usr),
        { name: 'data-capture-extract', run_type: 'llm' },
      );
      const raw = await traced(buildExtractSystem(listenFor, extract), userMessage);
      if (!raw) return;
      const parsed = JSON.parse(raw.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim()) as Record<string, unknown>;
      if (parsed.found !== true) return;

      const segments = extract.map(key => `${key}: ${String(parsed[key] ?? 'n/a').slice(0, 200)}`);
      const line = `${segments.join(' | ')} | Captured: ${new Date().toISOString().slice(0, 10)}`;
      const lineKey = segments.join(' | ');

      const conn = await getOrgConnection(orgId);
      const safeId = recordId.replace(/[^a-zA-Z0-9]/g, '');
      const rows = await conn.query<Record<string, unknown>>(
        `SELECT Id, ${cfg.field} FROM ${recordType} WHERE Id = '${safeId}'`,
      );
      const row = rows.records[0];
      if (!row) return;
      const existing = typeof row[cfg.field] === 'string' ? (row[cfg.field] as string) : '';
      // Append-only field; skip an exact repeat of the same captured values.
      if (existing.includes(lineKey)) return;
      await conn.sobject(recordType).update({
        Id: recordId,
        [cfg.field]: existing ? `${existing}\n${line}` : line,
      });
      logger.info({ orgId, recordId, field: cfg.field }, 'data_capture_stored');
    } catch (err) {
      logger.warn({ orgId, err: err instanceof Error ? err.message : err }, 'data_capture_skipped');
    }
  })();
}

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

const EXTRACT_SYSTEM =
  'You extract competitor intelligence from ONE customer message in a sales negotiation. Reply as JSON: ' +
  '{"found": boolean, "vendor": string|null, "price": string|null, "includes": string|null}. ' +
  'found=true ONLY if the message references a competing vendor/provider offer (a name, or clearly "another vendor") ' +
  'with a price or terms. vendor: the vendor name, or "(unnamed)". price: the amount as stated, normalized to digits ' +
  '(e.g. "40,000" for 40k). includes: what their offer covers, or null. No commentary — JSON only.';

export function maybeStoreCompetitorIntelAsync(args: {
  orgId: string;
  recordId: string;
  recordType: string;
  field: string;
  userMessage: string;
  engineOverride?: EngineOverrideInput | null;
}): void {
  const { orgId, recordId, recordType, field, userMessage, engineOverride } = args;
  if (!engineOverride?.apiKey) return;
  if (!SAFE_NAME_RE.test(field) || !SAFE_NAME_RE.test(recordType)) return;
  if (!PREFILTER_MONEY.test(userMessage) || !PREFILTER_VENDOR.test(userMessage)) return;

  void (async () => {
    try {
      const traced = traceable(
        (sys: string, usr: string) => callCheapModel(engineOverride, sys, usr),
        { name: 'competitor-intel-extract', run_type: 'llm' },
      );
      const raw = await traced(EXTRACT_SYSTEM, userMessage);
      if (!raw) return;
      const parsed = JSON.parse(raw.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim()) as {
        found?: boolean; vendor?: unknown; price?: unknown; includes?: unknown;
      };
      if (!parsed.found) return;

      const vendor = String(parsed.vendor ?? '(unnamed)').slice(0, 80);
      const price = String(parsed.price ?? 'n/a').slice(0, 40);
      const includes = String(parsed.includes ?? 'n/a').slice(0, 200);

      const conn = await getOrgConnection(orgId);
      const safeId = recordId.replace(/[^a-zA-Z0-9]/g, '');
      const rows = await conn.query<Record<string, unknown>>(
        `SELECT Id, ${field} FROM ${recordType} WHERE Id = '${safeId}'`,
      );
      const row = rows.records[0];
      if (!row) return;
      const existing = typeof row[field] === 'string' ? (row[field] as string) : '';
      // Append-only field; skip only an exact same-vendor-same-price repeat.
      if (existing.includes(`Vendor: ${vendor}`) && existing.includes(`Price: ${price}`)) return;
      const line = `Vendor: ${vendor} | Price: ${price} | Includes: ${includes} | Captured: ${new Date().toISOString().slice(0, 10)}`;
      await conn.sobject(recordType).update({
        Id: recordId,
        [field]: existing ? `${existing}\n${line}` : line,
      });
      logger.info({ orgId, recordId, vendor }, 'competitor_intel_stored');
    } catch (err) {
      logger.warn({ orgId, err: err instanceof Error ? err.message : err }, 'competitor_intel_skipped');
    }
  })();
}

/**
 * Deterministic competitor-intel capture — the "code for invariants" fix for
 * a requirement that prompt instructions satisfied only intermittently
 * (eval-confirmed: the same vendor+price message stored intel on one run and
 * skipped it on the next, depending on whether the agent felt like calling
 * the tool).
 *
 * After every customer-facing turn on an Opportunity-anchored session, a
 * cheap regex prefilter checks the USER message for vendor+money signals; on
 * a hit, the org's cheap model extracts {vendor, price, includes} and the
 * SERVER appends the line to Opportunity.CompetitorIntel__c itself via
 * jsforce — no agent tool call involved. Fire-and-forget (memory-summarizer
 * pattern): zero reply latency, fail-open on any error (orgs without the
 * client-org field just log and skip).
 */
import { traceable } from 'langsmith/traceable';
import { logger } from '../logger';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { callCheapModel } from './memory';
import type { EngineOverrideInput } from './adapters/types';

const PREFILTER_MONEY = /(?:\$\s?\d|\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?k\b|\b\d{4,}\b)/i;
const PREFILTER_VENDOR = /\b(?:vendor|competitor|market|another|other|elsewhere|quote\w*|offer\w*|gives?|giving|found|checked|provider|company|cheaper|better\s+price)\b/i;

const EXTRACT_SYSTEM =
  'You extract competitor intelligence from ONE customer message in a sales negotiation. Reply as JSON: ' +
  '{"found": boolean, "vendor": string|null, "price": string|null, "includes": string|null}. ' +
  'found=true ONLY if the message references a competing vendor/provider offer (a name, or clearly "another vendor") ' +
  'with a price or terms. vendor: the vendor name, or "(unnamed)". price: the amount as stated, normalized to digits ' +
  '(e.g. "40,000" for 40k). includes: what their offer covers, or null. No commentary — JSON only.';

export function maybeStoreCompetitorIntelAsync(args: {
  orgId: string;
  opportunityId: string;
  userMessage: string;
  engineOverride?: EngineOverrideInput | null;
}): void {
  const { orgId, opportunityId, userMessage, engineOverride } = args;
  if (!engineOverride?.apiKey) return;
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
      const safeId = opportunityId.replace(/[^a-zA-Z0-9]/g, '');
      const rows = await conn.query<{ Id: string; CompetitorIntel__c: string | null }>(
        `SELECT Id, CompetitorIntel__c FROM Opportunity WHERE Id = '${safeId}'`,
      );
      const row = rows.records[0];
      if (!row) return;
      const existing = row.CompetitorIntel__c ?? '';
      // Append-only field; skip only an exact same-vendor-same-price repeat.
      if (existing.includes(`Vendor: ${vendor}`) && existing.includes(`Price: ${price}`)) return;
      const line = `Vendor: ${vendor} | Price: ${price} | Includes: ${includes} | Captured: ${new Date().toISOString().slice(0, 10)}`;
      await conn.sobject('Opportunity').update({
        Id: opportunityId,
        CompetitorIntel__c: existing ? `${existing}\n${line}` : line,
      });
      logger.info({ orgId, opportunityId, vendor }, 'competitor_intel_stored');
    } catch (err) {
      logger.warn({ orgId, err: err instanceof Error ? err.message : err }, 'competitor_intel_skipped');
    }
  })();
}

/**
 * Escalation reconciler — the invariant "an escalated record never stays in
 * its lost stage" moved from prompt to code. Eval-confirmed variance: on
 * identical escalations the model sometimes created the Task and Event but
 * skipped the stage update.
 *
 * FULLY CONFIG-DRIVEN: the stage field and both stage values come from the
 * agent's guardrails config (`escalation.stageField/fromStage/toStage`);
 * the target is the session's anchored record. Nothing here names an
 * agent, org, field, or stage value — agents without the config never run
 * this. When a turn successfully creates a Task or Event, the SERVER moves
 * a record still in fromStage to toStage itself. Fire-and-forget,
 * fail-open — same pattern as competitor-intel.ts.
 */
import { logger } from '../logger';
import { getOrgConnection } from '../salesforce/per-org-connection';
import type { ToolCallSummary } from './adapters/types';
import type { EscalationConfig } from './pricing-guardrails';

const SAFE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;

export function maybeReconcileEscalationAsync(args: {
  orgId: string;
  recordId: string;
  recordType: string;
  toolCalls: ToolCallSummary[];
  cfg: EscalationConfig;
}): void {
  const { orgId, recordId, recordType, toolCalls, cfg } = args;
  if (!SAFE_NAME_RE.test(cfg.stageField) || !SAFE_NAME_RE.test(recordType)) return;

  const createdActivity = toolCalls.some(t => {
    if (t.name !== 'createSobjectRecord' || t.isError) return false;
    const sobject = (t.input as { 'sobject-name'?: unknown })?.['sobject-name'];
    return sobject === 'Task' || sobject === 'Event';
  });
  if (!createdActivity) return;

  void (async () => {
    try {
      const conn = await getOrgConnection(orgId);
      const safeId = recordId.replace(/[^a-zA-Z0-9]/g, '');
      const rows = await conn.query<Record<string, unknown>>(
        `SELECT Id, ${cfg.stageField} FROM ${recordType} WHERE Id = '${safeId}'`,
      );
      const row = rows.records[0];
      if (!row || row[cfg.stageField] !== cfg.fromStage) return;
      await conn.sobject(recordType).update({ Id: recordId, [cfg.stageField]: cfg.toStage });
      logger.info({ orgId, recordId, toStage: cfg.toStage }, 'escalation_stage_reconciled');
    } catch (err) {
      logger.warn({ orgId, err: err instanceof Error ? err.message : err }, 'escalation_reconcile_skipped');
    }
  })();
}

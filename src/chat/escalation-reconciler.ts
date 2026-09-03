/**
 * Escalation reconciler — the invariant "an escalated deal never stays
 * Closed Lost" moved from prompt to code. Eval-confirmed variance: on
 * identical escalations the model sometimes created the Task and Event but
 * skipped the stage update (procedure step b). When a customer-facing turn
 * successfully creates a Task or Event on the anchored Opportunity, the
 * SERVER moves a still-Closed-Lost stage to the revival stage itself.
 * Fire-and-forget, fail-open — same pattern as competitor-intel.ts.
 *
 * REVIVAL_STAGE is a client-org value for now; the platform version reads
 * it from per-agent guardrail config.
 */
import { logger } from '../logger';
import { getOrgConnection } from '../salesforce/per-org-connection';
import type { ToolCallSummary } from './adapters/types';

const REVIVAL_STAGE = 'Negotiation/Review';
const LOST_STAGE = 'Closed Lost';

export function maybeReconcileEscalationAsync(args: {
  orgId: string;
  opportunityId: string;
  toolCalls: ToolCallSummary[];
}): void {
  const { orgId, opportunityId, toolCalls } = args;
  const createdActivity = toolCalls.some(t => {
    if (t.name !== 'createSobjectRecord' || t.isError) return false;
    const sobject = (t.input as { 'sobject-name'?: unknown })?.['sobject-name'];
    return sobject === 'Task' || sobject === 'Event';
  });
  if (!createdActivity) return;

  void (async () => {
    try {
      const conn = await getOrgConnection(orgId);
      const safeId = opportunityId.replace(/[^a-zA-Z0-9]/g, '');
      const rows = await conn.query<{ Id: string; StageName: string }>(
        `SELECT Id, StageName FROM Opportunity WHERE Id = '${safeId}'`,
      );
      const row = rows.records[0];
      if (!row || row.StageName !== LOST_STAGE) return;
      await conn.sobject('Opportunity').update({ Id: opportunityId, StageName: REVIVAL_STAGE });
      logger.info({ orgId, opportunityId }, 'escalation_stage_reconciled');
    } catch (err) {
      logger.warn({ orgId, err: err instanceof Error ? err.message : err }, 'escalation_reconcile_skipped');
    }
  })();
}

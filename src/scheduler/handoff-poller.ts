/**
 * Hands conversations back to their agent once the quiet period has run
 * out: a person took the chat, nobody wrote for N hours (the node's
 * setting, default 12), so the agent takes it again. One query per org on
 * a plain interval, like run-poller.ts. Apex does the transcript line and
 * the customer's return line from the status change (ChatSessionTrigger).
 *
 * Free-tier reality: this fires only while the process is awake; a return
 * due while the server sleeps happens on the next wake, which also sweeps
 * once at boot.
 */
import { prisma } from '../db/client';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { pkgConn } from '../salesforce/namespace';
import { logger } from '../logger';

const POLL_INTERVAL_MS = Number(process.env.HANDOFF_POLL_MS) || 60_000;
let timer: NodeJS.Timeout | null = null;

export function startHandoffPoller(): void {
  if (timer) return;
  sweep().catch(err => logger.error({ err }, 'handoff_poller_boot_sweep_failed'));
  timer = setInterval(() => { sweep().catch(err => logger.error({ err }, 'handoff_poller_sweep_failed')); }, POLL_INTERVAL_MS);
  logger.info({ intervalMs: POLL_INTERVAL_MS }, 'handoff_poller_started');
}

export function stopHandoffPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

interface Due { Id: string; HandoffReturnHours__c: number | null; HandoffPreviousOwner__c: string | null }

export async function sweep(): Promise<number> {
  const orgs = await prisma.orgInstall.findMany({ select: { orgId: true } });
  let returned = 0;
  for (const { orgId } of orgs) {
    try {
      const pc = pkgConn(await getOrgConnection(orgId));
      const due = await pc.query<Due>(
        "SELECT Id, HandoffReturnHours__c, HandoffPreviousOwner__c FROM ChatSession__c WHERE Status__c = 'Handed off' AND HandoffReturnAt__c != null AND HandoffReturnAt__c <= " +
          new Date().toISOString() + ' LIMIT 50',
      );
      for (const s of due.records) {
        const hours = s.HandoffReturnHours__c && s.HandoffReturnHours__c > 0 ? s.HandoffReturnHours__c : 12;
        const patch: Record<string, unknown> = {
          Id: s.Id,
          Status__c: 'Active',
          HandoffReturnAt__c: null,
          HandoffReturnNote__c: `No reply for ${hours} hours, so the conversation came back to the agent.`,
          HandoffReturnedBy__c: null,
          LastActivityAt__c: new Date().toISOString(),
        };
        if (s.HandoffPreviousOwner__c) patch.OwnerId = s.HandoffPreviousOwner__c;
        try {
          await pc.sobject('ChatSession__c').update(patch);
        } catch (err) {
          // An owner that cannot be restored must not keep the conversation handed off.
          logger.warn({ orgId, sessionId: s.Id, err: err instanceof Error ? err.message : String(err) }, 'handoff_return_owner_failed');
          delete patch.OwnerId;
          await pc.sobject('ChatSession__c').update(patch);
        }
        returned++;
        logger.info({ orgId, sessionId: s.Id, hours }, 'handoff_returned_after_quiet');
      }
    } catch (err) {
      // An org whose token is gone, or that has no such field yet: skip it this round.
      logger.debug({ orgId, err: err instanceof Error ? err.message : String(err) }, 'handoff_poller_org_skipped');
    }
  }
  return returned;
}

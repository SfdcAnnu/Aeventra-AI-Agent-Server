import { getOrgConnection } from './per-org-connection';
import { config } from '../config';
import { logger } from '../logger';
import type { GraphResult } from '../types';

/**
 * Report a finished async run back to Salesforce.
 *
 * WRITTEN DIRECTLY, NOT PUBLISHED AS AN EVENT.
 *
 * This used to create an AgentExecutionResult__e Platform Event, which
 * AgentExecutionResultTrigger handed to AgentExecutionResultHandler, which
 * upserted AgentExecution__c on CorrelationId__c. Three hops to perform a
 * write the server can do itself — and the first hop is a feature
 * Professional Edition does not have.
 *
 * On a PE org every publish failed, the `catch` logged one line, and the
 * run's outcome never arrived. The Execution Log sat on QUEUED or
 * WAITING_APPROVAL forever, exactly as runs.routes.ts warned it would.
 * Nothing surfaced it, because a swallowed error looks identical to
 * success from the outside.
 *
 * So the server upserts the record. Same external id, same fields, same
 * result — minus the edition dependency, minus two hops, and minus a
 * trigger that has to be active and a handler that has to be in the
 * package. The event, its trigger and its handler are now unused; they
 * are left in place because removing Apex from a package that may already
 * be installed somewhere is a separate decision.
 *
 * Uses the ORG's own connection (Archon Setup tokens), not the shared
 * bootstrap user — writing to an org as a stranger would be a
 * multi-tenancy leak.
 */
export async function schedulePlatformEvent(args: {
  orgId: string;
  agentApiName: string;
  recordId: string;
  result: GraphResult;
}): Promise<void> {
  const correlationId = args.result.correlationId;
  try {
    const conn = await getOrgConnection(args.orgId);

    // AgentDefinition__c is a lookup, so it needs the Id. The handler did
    // this same query in Apex; doing it here costs one SOQL and keeps the
    // record's shape identical to what the trigger produced.
    const agentId = await lookupAgentId(conn, args.agentApiName);
    if (!agentId) {
      logger.warn({ correlationId, agentApiName: args.agentApiName }, 'execution_result_agent_not_found');
    }

    const record = {
      CorrelationId__c: correlationId,
      ...(agentId ? { AgentDefinition__c: agentId } : {}),
      RecordId__c: args.recordId || null,
      Status__c: args.result.agentStatus,
      AgentScore__c: args.result.agentScore ?? null,
      AgentPriority__c: args.result.agentPriority ?? null,
      AgentReason__c: args.result.agentReason ?? null,
      ToolsUsed__c: args.result.toolsUsed.join(',').slice(0, 255),
      OutputPayload__c: JSON.stringify(args.result.agentOutputPayload).slice(0, 32_000),
      ExecutionMs__c: args.result.durationMs,
    };

    const sobject = (conn as unknown as {
      sobject: (name: string) => {
        upsert: (data: unknown, extIdField: string) => Promise<unknown>;
      };
    }).sobject('AgentExecution__c');

    // Upsert on the external id, exactly as the handler's
    // `upsert toUpsert CorrelationId__c` did: the queued row written at
    // request time is updated, and a run with no queued row still lands.
    const res = await sobject.upsert(record, 'CorrelationId__c');
    logger.info({ res, correlationId, status: args.result.agentStatus }, 'execution_result_written');
  } catch (err) {
    // Still non-fatal — the run itself succeeded and its result is in this
    // server's own tables. But it is an ERROR, not a shrug: the org's
    // Execution Log is now out of date and only this line says so.
    logger.error(
      { err: err instanceof Error ? err.message : err, correlationId },
      'execution_result_write_failed',
    );
  }
}

/** Agent API name → record Id, briefly cached: an async run reports once,
 *  but a busy org reports many runs for the same few agents. */
const AGENT_ID_TTL_MS = 5 * 60_000;
const agentIdCache = new Map<string, { id: string | null; at: number }>();

async function lookupAgentId(conn: unknown, apiName: string): Promise<string | null> {
  const key = `${(conn as { instanceUrl?: string }).instanceUrl ?? ''}|${apiName}`;
  const hit = agentIdCache.get(key);
  if (hit && Date.now() - hit.at < AGENT_ID_TTL_MS) return hit.id;

  const q = conn as { query: (soql: string) => Promise<{ records?: Array<{ Id: string }> }> };
  // apiName comes from the agent record this run was dispatched for, not
  // from user input, but it is still quoted into SOQL — so anything that
  // is not a plain API name is refused rather than escaped.
  if (!/^[A-Za-z0-9_]{1,80}$/.test(apiName)) return null;
  const rows = await q.query(
    `SELECT Id FROM AgentDefinition__c WHERE ApiName__c = '${apiName}' LIMIT 1`,
  );
  const id = rows.records?.[0]?.Id ?? null;
  agentIdCache.set(key, { id, at: Date.now() });
  return id;
}

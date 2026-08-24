import { getOrgConnection } from './per-org-connection';
import { config } from '../config';
import { logger } from '../logger';
import type { GraphResult } from '../types';

/**
 * Publish an AgentExecutionResult__e Platform Event so SF can update
 * AgentExecution__c records for async runs without polling.
 *
 * Uses the ORG's own connection (Archon Setup tokens), not the shared
 * bootstrap user — publishing as a stranger to the org's own event bus
 * would be a multi-tenancy leak.
 */
export async function schedulePlatformEvent(args: {
  orgId: string;
  agentApiName: string;
  recordId: string;
  result: GraphResult;
}): Promise<void> {
  try {
    const conn = await getOrgConnection(args.orgId);
    const eventName = config.salesforce.callbackEvent;
    const payload = {
      AgentApiName__c: args.agentApiName,
      CorrelationId__c: args.result.correlationId,
      RecordId__c: args.recordId,
      Status__c: args.result.agentStatus,
      AgentScore__c: args.result.agentScore ?? null,
      AgentPriority__c: args.result.agentPriority ?? null,
      AgentReason__c: args.result.agentReason ?? null,
      ToolsUsed__c: args.result.toolsUsed.join(',').slice(0, 255),
      OutputPayload__c: JSON.stringify(args.result.agentOutputPayload).slice(0, 32_000),
      ExecutionMs__c: args.result.durationMs,
    };

    const sobject = (conn as unknown as { sobject: (name: string) => { create: (data: unknown) => Promise<unknown> } }).sobject(eventName);
    const res = await sobject.create(payload);
    logger.info({ res, correlationId: args.result.correlationId }, 'platform_event_published');
  } catch (err) {
    logger.error({ err, correlationId: args.result.correlationId }, 'platform_event_publish_failed');
  }
}

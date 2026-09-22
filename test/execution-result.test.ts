import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsert = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true }));
const query = vi.hoisted(() => vi.fn().mockResolvedValue({ records: [{ Id: 'a00AGENT' }] }));
vi.mock('../src/salesforce/per-org-connection', () => ({
  getOrgConnection: vi.fn().mockResolvedValue({
    instanceUrl: 'https://x.my.salesforce.com',
    query,
    sobject: () => ({ upsert }),
  }),
}));

import { schedulePlatformEvent } from '../src/salesforce/callback';

/**
 * An async run's outcome used to travel Platform Event → trigger →
 * handler → AgentExecution__c. Platform Events are not a Professional
 * Edition feature, so on PE every publish failed, the catch logged one
 * line, and the Execution Log sat on QUEUED or WAITING_APPROVAL forever.
 *
 * The server writes the record itself now. These hold that it writes the
 * SAME record the handler did — same object, same external id — and that
 * a failure is still non-fatal to the run.
 */
const result = {
  correlationId: 'async-123',
  agentStatus: 'COMPLETED',
  agentScore: 82,
  agentPriority: 'Hot',
  agentReason: 'Qualified',
  toolsUsed: ['soqlQuery', 'createSobjectRecord'],
  agentOutputPayload: { leadId: '00Q1' },
  durationMs: 4200,
} as never;

const run = () => schedulePlatformEvent({
  orgId: '00D1', agentApiName: 'lead_qualifier', recordId: '00Q1', result,
});

describe('reporting an async run back to Salesforce', () => {
  beforeEach(() => { upsert.mockClear(); query.mockClear(); });

  it('upserts AgentExecution__c on the external id, as the handler did', async () => {
    await run();
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert.mock.calls[0][1]).toBe('CorrelationId__c');
  });

  it('publishes no platform event', async () => {
    // The whole point: nothing here needs an event bus.
    await run();
    const [record] = upsert.mock.calls[0];
    expect(JSON.stringify(record)).not.toContain('__e');
  });

  it('carries every field the trigger used to set', async () => {
    await run();
    expect(upsert.mock.calls[0][0]).toMatchObject({
      CorrelationId__c: 'async-123',
      AgentDefinition__c: 'a00AGENT',
      Status__c: 'COMPLETED',
      AgentScore__c: 82,
      AgentPriority__c: 'Hot',
      ToolsUsed__c: 'soqlQuery,createSobjectRecord',
      ExecutionMs__c: 4200,
    });
  });

  it('still writes when the agent record cannot be found', async () => {
    // A missing lookup must not cost the org the status of the run.
    query.mockResolvedValueOnce({ records: [] });
    await schedulePlatformEvent({ orgId: '00D2', agentApiName: 'ghost_agent', recordId: '00Q1', result });
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert.mock.calls[0][0]).not.toHaveProperty('AgentDefinition__c');
  });

  it('refuses an api name that is not a plain api name, rather than quoting it into SOQL', async () => {
    await schedulePlatformEvent({ orgId: '00D3', agentApiName: "x' OR Id!=null--", recordId: '', result });
    expect(query).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledOnce();
  });

  it('never throws — the run already succeeded', async () => {
    upsert.mockRejectedValueOnce(new Error('INVALID_SESSION_ID'));
    await expect(run()).resolves.toBeUndefined();
  });
});

/**
 * A decision on a chat approval is written into the conversation as a
 * System message with who, what, when and the outcome — and a failure to
 * write it never surfaces to the decider.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const created: Array<Record<string, unknown>> = [];
const conn = {
  query: vi.fn(async (soql: string) => {
    if (soql.startsWith('SELECT Name FROM User')) return { records: [{ Name: 'Pratima Patel' }] };
    if (soql.startsWith('SELECT SequenceNumber__c')) return { records: [{ SequenceNumber__c: 7 }] };
    return { records: [] };
  }),
  sobject: vi.fn(() => ({ create: vi.fn(async (row: Record<string, unknown>) => { created.push(row); return { success: true }; }) })),
};
vi.mock('../src/salesforce/per-org-connection', () => ({ getOrgConnection: vi.fn(async () => conn) }));

import { recordApprovalDecision } from '../src/salesforce/approval-audit';

const row = {
  id: 'apr_1', orgId: '00D', agentApiName: 'metadata_expert', planVersion: null, sessionId: 'a08g500000CljqnAAB', userId: '005A',
  recordContextId: null, recordContextType: null, toolName: 'deploy', argsJson: { changeId: 'chg_msrcx3AMnem0Ic8E' },
  status: 'Executed', resultText: null, decidedBy: '005B', decidedAt: new Date(), timeoutAt: new Date(), createdAt: new Date('2026-09-19T10:00:00Z'), updatedAt: new Date(),
};

describe('approval audit', () => {
  beforeEach(() => { created.length = 0; });
  it('writes the decision under the session as the next System message', async () => {
    await recordApprovalDecision(row as never, 'approved', '005B', { status: 'Executed', resultText: 'Deployed.' });
    expect(created).toHaveLength(1);
    const m = created[0];
    expect(m.ChatSession__c).toBe('a08g500000CljqnAAB');
    expect(m.Role__c).toBe('System');
    expect(m.SequenceNumber__c).toBe(8);
    expect(m.ApprovalStatus__c).toBe('Approved');
    expect(m.RequiredApproval__c).toBe(true);
    expect(String(m.Content__c)).toContain('Approved by Pratima Patel');
    expect(String(m.Content__c)).toContain('deploy(changeId=chg_msrcx3AMnem0Ic8E)');
    const audit = JSON.parse(String(m.ToolCallsJson__c));
    expect(audit).toMatchObject({ approvalId: 'apr_1', toolName: 'deploy', decision: 'approved', decidedBy: '005B', decidedByName: 'Pratima Patel', status: 'Executed', resultText: 'Deployed.' });
  });
  it('records a rejection as Declined', async () => {
    await recordApprovalDecision(row as never, 'rejected', '005B', { status: 'Rejected' });
    expect(created[0].ApprovalStatus__c).toBe('Declined');
    expect(String(created[0].Content__c)).toMatch(/^Rejected by Pratima Patel/);
  });
  it('never throws when the org write fails', async () => {
    conn.sobject.mockImplementationOnce(() => ({ create: vi.fn(async () => { throw new Error('INSUFFICIENT_ACCESS'); }) }));
    await expect(recordApprovalDecision(row as never, 'approved', '005B', { status: 'Executed' })).resolves.toBeUndefined();
  });
});

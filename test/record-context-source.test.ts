import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveWsChatSession } from '../src/salesforce/ws-chat-persistence';

/**
 * WHERE THE RECORD ID COMES FROM IS A SECURITY DECISION, NOT A CONVENIENCE.
 *
 * chat/record-context.ts reads the anchored record with getOrgConnection —
 * the ORG's integration connection, not the caller's. So a record id taken
 * off the WebSocket would let any user read any record in the org and skip
 * their own sharing rules entirely.
 *
 * It therefore comes from ChatSession__c, written by Apex when the session
 * was created, through that user's own permissions. These tests hold that
 * source. If one fails because someone "simplified" it to read the message
 * body, that is a privilege escalation, not a refactor.
 */
const conn = (sessionRow: Record<string, unknown> | null) => ({
  query: vi.fn(async (soql: string) => {
    if (soql.includes('FROM ChatSession__c')) return { records: sessionRow ? [sessionRow] : [] };
    if (soql.includes('FROM ChatMessage__c')) return { records: [{ SequenceNumber__c: 4 }] };
    return { records: [] };
  }),
  sobject: () => ({ create: async () => ({ id: 'a08NEW', success: true }) }),
}) as never;

describe('the anchored record comes from the session row', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the record the session was created against', async () => {
    const s = await resolveWsChatSession(
      conn({ Id: 'a08g500000CpPByAAN', RecordContextId__c: '00Qg5000008cYQf', RecordContextType__c: 'Lead' }),
      'a08g500000CpPByAAN', 'a00AGENT', '005USER', undefined,
    );
    expect(s.recordContextId).toBe('00Qg5000008cYQf');
    expect(s.recordContextType).toBe('Lead');
  });

  it('asks Salesforce for those two fields, not just the Id', async () => {
    const c = conn({ Id: 'a08g500000CpPByAAN', RecordContextId__c: null, RecordContextType__c: null });
    await resolveWsChatSession(c, 'a08g500000CpPByAAN', 'a00AGENT', '005USER', undefined);
    const soql = (c as unknown as { query: { mock: { calls: string[][] } } }).query.mock.calls[0][0];
    expect(soql).toContain('RecordContextId__c');
    expect(soql).toContain('RecordContextType__c');
  });

  it('scopes the lookup to the agent, so one agent cannot read another’s session', async () => {
    const c = conn({ Id: 'a08g500000CpPByAAN', RecordContextId__c: null, RecordContextType__c: null });
    await resolveWsChatSession(c, 'a08g500000CpPByAAN', 'a00AGENT', '005USER', undefined);
    const soql = (c as unknown as { query: { mock: { calls: string[][] } } }).query.mock.calls[0][0];
    expect(soql).toContain("AgentDefinition__c = 'a00AGENT'");
  });

  it('anchors to nothing when the session has no record', async () => {
    const s = await resolveWsChatSession(
      conn({ Id: 'a08g500000CpPByAAN', RecordContextId__c: null, RecordContextType__c: null }),
      'a08g500000CpPByAAN', 'a00AGENT', '005USER', undefined,
    );
    expect(s.recordContextId).toBeNull();
  });

  it('anchors to nothing for a session this server had to create', async () => {
    // A throwaway session (the test panel's client-generated id) is not a
    // real row, so there is no record behind it to inherit.
    const s = await resolveWsChatSession(conn(null), 'client-generated-id', 'a00AGENT', '005USER', undefined);
    expect(s.recordContextId).toBeNull();
    expect(s.recordContextType).toBeNull();
  });

  it('still returns the sequence number the transcript needs', async () => {
    const s = await resolveWsChatSession(
      conn({ Id: 'a08g500000CpPByAAN', RecordContextId__c: '00Q1', RecordContextType__c: 'Lead' }),
      'a08g500000CpPByAAN', 'a00AGENT', '005USER', undefined,
    );
    expect(s.nextSeq).toBe(5);
  });
});

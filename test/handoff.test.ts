import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The handoff tool writes the handoff state onto the session and tells the
 * model the one line to say; a second call is refused; the history lines
 * Apex writes come back to the model as what they mean.
 */
const updates: Array<{ object: string; data: Record<string, unknown> }> = [];
let sessionStatus = 'Active';
let recordOwner = '005000000000001AAA';

vi.mock('../src/salesforce/per-org-connection', () => ({ getOrgConnection: vi.fn(async () => ({})) }));
vi.mock('../src/salesforce/namespace', () => ({
  pkgConn: () => ({
    query: vi.fn(async (soql: string) => {
      if (/FROM ChatSession__c/.test(soql)) return { records: [{ Id: 'a0Ag50000000001AAA', Status__c: sessionStatus, OwnerId: '005000000000009AAA', User__c: '005000000000009AAA', RecordContextId__c: '00Qg50000000001AAA', RecordContextType__c: 'Lead', Channel__c: 'whatsapp' }] };
      if (/SELECT OwnerId FROM Lead/.test(soql)) return { records: [{ OwnerId: recordOwner }] };
      if (/FROM User/.test(soql)) return { records: [{ Name: 'Rahul Mehta' }] };
      if (/FROM Group/.test(soql)) return { records: [{ Name: 'WhatsApp Sales' }] };
      return { records: [] };
    }),
    sobject: (object: string) => ({ update: vi.fn(async (data: Record<string, unknown>) => { updates.push({ object, data }); return { success: true }; }) }),
  }),
}));

const { buildHandoffTools, DEFAULT_HANDOFF_LINE } = await import('../src/lc/handoff-tool');
const { isHandoffLine, handoffLineMessage } = await import('../src/chat/handoff-return');

const ctx = { orgId: '00D', sessionId: 'a0Ag50000000001AAA', recordContextId: '00Qg50000000001AAA', recordContextType: 'Lead' };
const ai = { id: 'a02g500000RootAAAA', name: 'Agent', nodeType: 'ai', nodeSubType: 'gpt4', isEnabled: true, config: {}, positionX: 0, positionY: 0, sortOrder: 0 };
const node = (config: Record<string, unknown>) => ({ id: 'a02g500000HandoffX', name: 'Hand off to a person', nodeType: 'tool', nodeSubType: 'tool', isEnabled: true, config, positionX: 0, positionY: 0, sortOrder: 1 });
/** The adjacency the runtime builds: root --tool--> node. */
const graphWith = (n: ReturnType<typeof node> | null) => ({
  nextByPort: new Map([[ai.id, new Map([['tool', n ? [n.id] : []]])]]),
  byId: new Map(n ? [[ai.id, ai], [n.id, n]] : [[ai.id, ai]]),
  ordered: n ? [ai, n] : [ai],
});

describe('hand_off_to_human', () => {
  beforeEach(() => { updates.length = 0; sessionStatus = 'Active'; recordOwner = '005000000000001AAA'; });

  it('is only there when a handoff node is wired to the agent', () => {
    expect(buildHandoffTools(ctx, graphWith(null) as never, ai as never)).toHaveLength(0);
    const tools = buildHandoffTools(ctx, graphWith(node({ actionType: 'Handoff' })) as never, ai as never);
    expect(tools.map(t => t.name)).toEqual(['hand_off_to_human']);
  });

  it('hands to the record owner by default, writes the state, and tells the model the one line to say', async () => {
    const [t] = buildHandoffTools(ctx, graphWith(node({ actionType: 'Handoff', returnAfterHours: 6 })) as never, ai as never);
    const out = String(await t.invoke({ reason: 'asked for a person about pricing' }));
    expect(out).toContain('HANDED OFF to Rahul Mehta');
    expect(out).toContain(`"${DEFAULT_HANDOFF_LINE}"`);
    expect(updates).toHaveLength(1);
    expect(updates[0].object).toBe('ChatSession__c');
    expect(updates[0].data).toMatchObject({
      Status__c: 'Handed off', HandoffReason__c: 'asked for a person about pricing', HandoffAssigneeType__c: 'owner',
      HandoffAssigneeId__c: '005000000000001AAA', HandoffAssigneeLabel__c: 'Rahul Mehta', HandoffReturnHours__c: 6, HandoffPreviousOwner__c: '005000000000009AAA',
    });
    expect(updates[0].data).not.toHaveProperty('OwnerId');   // the owner option changes nobody's ownership
  });

  it('an Omni-Channel queue takes the conversation itself: the owner becomes the queue', async () => {
    const n = node({ actionType: 'Handoff', whoTakesOver: 'omni', assigneeId: '00Gg50000000001AAA', customerLineOnHandoff: 'One moment, a colleague is joining.' });
    const [t] = buildHandoffTools(ctx, graphWith(n) as never, ai as never);
    const out = String(await t.invoke({ reason: 'refund' }));
    expect(out).toContain('HANDED OFF to WhatsApp Sales');
    expect(out).toContain('"One moment, a colleague is joining."');
    expect(updates[0].data).toMatchObject({ OwnerId: '00Gg50000000001AAA', HandoffAssigneeType__c: 'omni' });
  });

  it('routes the related Lead instead when the node says so', async () => {
    const n = node({ actionType: 'Handoff', whoTakesOver: 'queue', assigneeId: '00Gg50000000001AAA', routeRelated: true });
    const [t] = buildHandoffTools(ctx, graphWith(n) as never, ai as never);
    await t.invoke({ reason: 'x' });
    expect(updates.map(u => u.object)).toEqual(['Lead', 'ChatSession__c']);
    expect(updates[0].data).toMatchObject({ Id: '00Qg50000000001AAA', OwnerId: '00Gg50000000001AAA' });
    expect(updates[1].data).not.toHaveProperty('OwnerId');
  });

  it('a second call while a person has it is refused with the same line', async () => {
    sessionStatus = 'Handed off';
    const [t] = buildHandoffTools(ctx, graphWith(node({ actionType: 'Handoff' })) as never, ai as never);
    const out = String(await t.invoke({ reason: 'again' }));
    expect(out).toContain('ALREADY HANDED OFF');
    expect(updates).toHaveLength(0);
  });
});

describe('the transcript lines, as the model reads them', () => {
  it('recognises the two lines Apex writes and nothing else', () => {
    expect(isHandoffLine('Handed off to Rahul Mehta · reason: pricing')).toBe(true);
    expect(isHandoffLine('Returned to the agent by Rahul Mehta · quote resent')).toBe(true);
    expect(isHandoffLine('Returned to the agent after the quiet period')).toBe(true);
    expect(isHandoffLine('Connected to Archon.')).toBe(false);
    expect(isHandoffLine(null)).toBe(false);
  });
  it('tells the agent to carry on from the person, not start over', () => {
    const back = handoffLineMessage('Returned to the agent by Rahul Mehta · pricing clarified, quote resent');
    expect(back).toContain('[BACK FROM A PERSON]');
    expect(back).toContain('do not greet the customer as if new');
    expect(handoffLineMessage('Handed off to Rahul Mehta · reason: pricing')).toContain('[HANDED OFF]');
  });
});

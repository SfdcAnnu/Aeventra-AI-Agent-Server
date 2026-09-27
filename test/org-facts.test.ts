import { describe, it, expect } from 'vitest';
import { mentionedObjects, verifyPrerequisites, settleTrigger, fitToLengths } from '../src/architect/org-facts';
import { textOf } from '../src/architect/build-detail';
import { inventoryFromGather } from '../src/architect/survey-inventory';
import type { ObjectSummary } from '../src/architect/surveyor-tools';
import type { AgentSpec, SpecPrerequisite } from '../src/architect/spec';

/**
 * Facts about the org are settled from the org, never from a model's
 * guess. Every case here uses more than one object on purpose: the rules
 * are general, not tuned to one requirement.
 */
const obj = (name: string, label: string, flags: Partial<ObjectSummary> = {}): ObjectSummary => ({
  name, label, custom: name.endsWith('__c'), queryable: true, createable: true, updateable: true, ...flags,
});
const ORG: ObjectSummary[] = [
  obj('Account', 'Account'), obj('Asset', 'Asset'), obj('WorkOrder', 'Work Order'), obj('Entitlement', 'Entitlement'),
  obj('Opportunity', 'Opportunity'), obj('FeedItem', 'Feed Item', { updateable: false }), obj('AccountHistory', 'Account History'),
  obj('Renewal_Plan__c', 'Renewal Plan'), obj('Group', 'Group', { queryable: false }),
];

describe('mentionedObjects', () => {
  it('finds objects by API name and by label, singular or plural', () => {
    const text = 'For each Work Order on the Account, check its Entitlements and the Renewal_Plan__c, then read all Assets and Opportunities.';
    expect(mentionedObjects(ORG, text).sort()).toEqual(['Account', 'Asset', 'Entitlement', 'Opportunity', 'Renewal_Plan__c', 'WorkOrder'].sort());
  });
  it('ignores history tables and objects that cannot be queried', () => {
    expect(mentionedObjects(ORG, 'Account History and the Group')).toEqual(['Account']);
  });
});

describe('the survey lists named objects first', () => {
  it('keeps a named standard object even past the size cap', () => {
    const many = Array.from({ length: 150 }, (_, i) => obj(`Custom${i}__c`, `Custom ${i}`));
    const inv = inventoryFromGather({ objects: [...many, ...ORG], invocables: [], mcp: [], knowledgeBases: [], crud: [], coreObjects: new Set(['Account', 'WorkOrder']), first: new Set(['WorkOrder']), maxObjects: 120 });
    const names = (inv.objects as Array<{ name: string }>).map(o => o.name);
    expect(names[0]).toBe('WorkOrder');
    expect(names).toHaveLength(120);
  });
});

describe('verifyPrerequisites', () => {
  const pre = (id: string, title: string, why = '', kind = 'field'): SpecPrerequisite =>
    ({ id, kind, title, why, steps: ['x'], assignee: 'salesforce_admin', blocking: true, status: 'pending' });
  const fields: Record<string, Record<string, { exists: boolean; updateable: boolean }>> = {
    Account: { Description: { exists: true, updateable: true }, Rating: { exists: true, updateable: false } },
  };
  const describeField = async (o: string, f: string) => fields[o]?.[f] ?? { exists: false, updateable: false };

  it('closes items the org contradicts, with the check that settled them', async () => {
    const { prerequisites, closed } = await verifyPrerequisites([
      pre('PRE-001', 'Account.Description field must exist and be updateable'),
      pre('PRE-002', 'Asset object is not available or queryable for this connection', '', 'data'),
      pre('PRE-003', 'No flow or invocable action available to post Chatter messages to the Account feed', '', 'flow'),
      pre('PRE-004', 'Work Order records cannot be created by the agent', '', 'permission'),
    ], ORG, describeField);
    expect(closed).toHaveLength(4);
    expect(prerequisites.every(p => p.status === 'done' && p.blocking === false)).toBe(true);
    expect(prerequisites[0].verification).toMatch(/Account.Description exists and can be written/);
    expect(prerequisites[2].verification).toMatch(/FeedItem/);
  });

  it('keeps items that are really missing, or not about absence at all', async () => {
    const { prerequisites, closed } = await verifyPrerequisites([
      pre('PRE-001', 'Account.Risk_Score__c field must exist'),
      pre('PRE-002', 'Account.Rating must be updated by the agent but is read-only', ''),
      pre('PRE-003', 'Outlook connector must be connected', '', 'connector'),
      pre('PRE-004', 'Decide the renewal threshold with the sales director', '', 'data'),
      pre('PRE-005', 'Contract object is not available', '', 'data'),
    ], ORG, describeField);
    expect(closed).toEqual([]);
    expect(prerequisites.every(p => p.status === 'pending')).toBe(true);
  });
});

describe('settleTrigger', () => {
  const spec = (type: string) => ({ trigger: { type } } as unknown as AgentSpec);
  it('runs from a Flow or Apex when Salesforce starts the agent', () => {
    for (const said of ['A Flow on an Account runs it with Record Id = Account Id.', 'Runs from Apex nightly', 'when a Case is created', 'on a schedule every Monday']) {
      const s = spec('webhook');
      expect(settleTrigger(s, said)).not.toBeNull();
      expect(s.trigger.type).toBe('manual');
    }
  });
  it('keeps a webhook when an outside system calls in, and leaves other triggers alone', () => {
    const w = spec('webhook');
    expect(settleTrigger(w, 'Our billing system calls it over a webhook when an invoice is paid; a Flow is not involved')).toBeNull();
    expect(w.trigger.type).toBe('webhook');
    const m = spec('inbound_message');
    expect(settleTrigger(m, 'a Flow starts it')).toBeNull();
  });
});

describe('fitToLengths', () => {
  it('shortens only what is over its field, at a word where it can', () => {
    const v: Record<string, unknown> = { Description__c: 'word '.repeat(80).trim(), Name: 'Short', Other: 5 };
    const clipped = fitToLengths(v, new Map([['Description__c', 255], ['Name', 80]]));
    expect(clipped).toEqual(['Description__c']);
    expect((v.Description__c as string).length).toBeLessThanOrEqual(255);
    expect(v.Description__c as string).toMatch(/…$/);
    expect(v.Name).toBe('Short');
  });
});

describe('textOf', () => {
  it('finds the text inside whatever shape a model returned', () => {
    expect(textOf({ object: 'Asset', reason: 'not surveyed' })).toBe('not surveyed');
    expect(textOf({ capability: { name: 'Post to Chatter' } })).toBe('Post to Chatter');
    expect(textOf([{ title: 'A' }, 'B'])).toBe('A; B');
    expect(textOf({ a: 1 })).toBe('');
    expect(String(textOf({ x: { y: 'z' } }))).not.toMatch(/object Object/);
  });
});

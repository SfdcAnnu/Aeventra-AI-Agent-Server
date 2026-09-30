import { describe, it, expect } from 'vitest';
import { soqlFieldRefs, collectFieldRefs, fieldProblems, type DescribeFields } from '../src/architect/field-check';
import type { AgentSpec } from '../src/architect/spec';

/**
 * The two real failures from the 30 Sep 2026 run, and what the check must
 * leave alone so it never fails a good build.
 */
const f = (name: string, o: Partial<{ filterable: boolean; createable: boolean; updateable: boolean }> = {}) =>
  [name.toLowerCase(), { name, filterable: true, createable: true, updateable: true, ...o }] as const;

const ORG: Record<string, ReturnType<typeof f>[]> = {
  PricebookEntry: [f('Id'), f('UnitPrice'), f('IsActive'), f('Product2Id'), f('Pricebook2Id')],
  Task: [f('Id'), f('Subject'), f('WhatId'), f('WhoId'), f('Description', { filterable: false }), f('ActivityDate')],
  Lead: [f('Id'), f('Email'), f('Status'), f('IsConverted', { createable: false, updateable: false })],
};
const describe_: DescribeFields = async o => (ORG[o] ? { fields: new Map(ORG[o]) } : null);

describe('reading fields out of SOQL', () => {
  it('takes plain fields from SELECT and WHERE, skips relationships, functions and literals', () => {
    const refs = soqlFieldRefs(
      "SELECT Id, UnitPrice, Product2.Name, COUNT(Id) FROM PricebookEntry WHERE Product2.Name = 'x = y' AND IsActive = true LIMIT 5",
      '/p',
    );
    expect(refs.map(r => `${r.use}:${r.field}`).sort()).toEqual(['filter:IsActive', 'read:Id', 'read:UnitPrice']);
  });
});

describe('the field check', () => {
  it('catches a field the org does not have (CurrencyIsoCode)', async () => {
    const errs = await fieldProblems(soqlFieldRefs('SELECT UnitPrice, CurrencyIsoCode FROM PricebookEntry', '/n/0/instructions'), describe_);
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(/PricebookEntry has no field "CurrencyIsoCode"/);
  });

  it('catches a filter on a long-text field (Task.Description)', async () => {
    const errs = await fieldProblems(soqlFieldRefs("SELECT Id FROM Task WHERE WhatId = '00Q1' AND Description LIKE '%key%'", '/p'), describe_);
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(/Task\.Description cannot be filtered on/);
  });

  it('checks flow writes and skips objects it cannot describe', async () => {
    const spec = {
      nodes: [{ id: 'a', type: 'agent', label: 'A', instructions: 'Query SELECT Id FROM Mystery__c WHERE Foo__c = 1' }],
      edges: [],
      flow: [
        { step: 'create_record', object: 'Lead', fields: { Email: '{!input.email}', IsConverted: 'true' } },
        { step: 'if', condition: 'x', then: [{ step: 'query_records', soql: 'SELECT Id, Nope FROM Lead' }] },
      ],
    } as unknown as AgentSpec;
    const errs = await fieldProblems(collectFieldRefs(spec, { instructions: true }), describe_);
    expect(errs.map(e => e.message).sort()).toEqual([
      'Lead has no field "Nope". Use a field that exists, or drop it.',
      'Lead.IsConverted cannot be set on create.',
    ]);
  });

  it('passes a clean design', async () => {
    const errs = await fieldProblems(soqlFieldRefs('SELECT Id, Email FROM Lead WHERE Status = \'New\'', '/p'), describe_);
    expect(errs).toEqual([]);
  });
});

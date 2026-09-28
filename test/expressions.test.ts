import { describe, it, expect, vi, afterEach } from 'vitest';
import { evaluateCondition, evaluateToken, interpolateText, tokenPaths, conditionProblems } from '../src/orchestrator/expressions';

/**
 * The automation engine's own conditions and values — what lets a rule
 * live on the canvas as an if/else instead of inside a model's prompt.
 * Cases span several objects and kinds of rule on purpose.
 */
const data: Record<string, unknown> = {
  'deal.CloseDate': '2026-09-17', 'deal.Amount': 80000, 'deal.StageName': 'Negotiation/Review', 'deal.Name': 'Big Deal',
  'deal.LastActivityDate': '2026-09-07', 'deal.NextStep': '', 'lead.Title': 'Chief Financial Officer', 'lead.Email': null,
  'case.Priority': 'High', 'case.IsEscalated': false,
  'deals.records': [{ Amount: 25000 }, { Amount: 40000 }, { Amount: 4000 }], 'recordId': '006x',
};
const resolve = (p: string) => data[p];

afterEach(() => vi.useRealTimers());

describe('values', () => {
  it('computes dates, days, formats and totals', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-28T10:00:00Z'));
    expect(evaluateToken('TODAY', resolve)).toBe('2026-09-28');
    expect(evaluateToken('DAYS_BETWEEN(deal.CloseDate, TODAY)', resolve)).toBe(11);
    expect(evaluateToken('ADD_BUSINESS_DAYS(\'2026-09-25\', 3)', resolve)).toBe('2026-09-30');
    expect(evaluateToken('ADD_MONTHS(\'2026-01-31\', 1)', resolve)).toBe('2026-02-28');
    expect(evaluateToken('ADD_DAYS(deal.CloseDate, -7)', resolve)).toBe('2026-09-10');
    expect(evaluateToken('YEAR(ADD_MONTHS(deal.CloseDate, 12))', resolve)).toBe(2027);
    expect(evaluateToken('FORMAT_NUMBER(deal.Amount)', resolve)).toBe('80,000');
    expect(evaluateToken('SUM(deals.records, \'Amount\')', resolve)).toBe(69000);
    expect(evaluateToken('COUNT(deals.records)', resolve)).toBe(3);
  });

  it('fills text, with functions inside it', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-28T10:00:00Z'));
    expect(interpolateText('Overdue deal: {!deal.Name}, {!DAYS_BETWEEN(deal.CloseDate, TODAY)} days, {!FORMAT_NUMBER(deal.Amount)}', resolve))
      .toBe('Overdue deal: Big Deal, 11 days, 80,000');
    expect(interpolateText('Missing: [{!lead.Email}]', resolve)).toBe('Missing: []');
  });

  it('puts a list or record into text as JSON, without Salesforce attributes', () => {
    const r = (p: string) => (p === 'tasks.records'
      ? [{ attributes: { type: 'Task' }, Subject: 'Call', ActivityDate: '2026-09-20' }, { attributes: { type: 'Task' }, Subject: 'Demo' }]
      : undefined);
    expect(interpolateText('Activity: {!tasks.records}', r)).toBe('Activity: [{"Subject":"Call","ActivityDate":"2026-09-20"},{"Subject":"Demo"}]');
  });

  it('names only the paths a token reads', () => {
    expect(tokenPaths("DAYS_BETWEEN(deal.CloseDate, TODAY)")).toEqual(['deal.CloseDate']);
    expect(tokenPaths("SUM(deals.records, 'Amount')")).toEqual(['deals.records']);
    expect(tokenPaths('recordId')).toEqual(['recordId']);
  });
});

describe('conditions', () => {
  it('compares dates as dates', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-28T10:00:00Z'));
    expect(evaluateCondition('{!deal.CloseDate} < {!TODAY}', resolve)).toBe(true);
    expect(evaluateCondition('{!DAYS_BETWEEN(deal.LastActivityDate, TODAY)} >= 14', resolve)).toBe(true);
  });

  it('combines clauses with AND and OR, AND first', () => {
    expect(evaluateCondition('{!deal.Amount} >= 50000 AND {!deal.StageName} != \'Closed Won\'', resolve)).toBe(true);
    expect(evaluateCondition('{!deal.Amount} < 1000 OR {!case.Priority} == \'High\' AND {!case.IsEscalated} == false', resolve)).toBe(true);
    expect(evaluateCondition('{!deal.Amount} < 1000 OR {!case.Priority} == \'Low\'', resolve)).toBe(false);
  });

  it('handles blanks and contains', () => {
    expect(evaluateCondition('{!deal.NextStep} is blank', resolve)).toBe(true);
    expect(evaluateCondition('{!lead.Email} is not blank', resolve)).toBe(false);
    expect(evaluateCondition('{!lead.Title} contains \'financial\'', resolve)).toBe(true);
  });

  it('never treats a missing date as before today', () => {
    expect(evaluateCondition('{!lead.Email} < {!TODAY}', resolve)).toBe(false);
  });

  it('keeps the old single-comparison shape working', () => {
    expect(evaluateCondition('{!deal.Amount} > 50000', resolve)).toBe(true);
    expect(evaluateCondition("{!case.Priority} == 'High'", resolve)).toBe(true);
  });

  it('reports a clause with no comparison', () => {
    expect(conditionProblems('{!deal.Amount} AND {!deal.StageName} == \'x\'')).toHaveLength(1);
    expect(conditionProblems('{!deal.Amount} >= 50000 AND {!deal.NextStep} is blank')).toEqual([]);
  });
});

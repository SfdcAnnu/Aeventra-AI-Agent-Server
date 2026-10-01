import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

/**
 * Findings N1, N3 and N5 of the 1 Oct 2026 verification run: built agents
 * had no AI key, the reply language stuck to an earlier message, and a
 * Task on a Lead used WhatId and failed after it had been approved.
 */
const repo = vi.hoisted(() => ({ findLatestForCall: vi.fn(), create: vi.fn() }));
vi.mock('../src/db/chat-approvals.repo', () => ({ ChatApprovalsRepo: repo, stableJson: (v: unknown) => JSON.stringify(v) }));
vi.mock('../src/db/client', () => ({ prisma: {} }));

import { argProblem } from '../src/lc/mcp-tools';
import { approvalGate } from '../src/lc/approval-gate';
import { latestLanguageNote } from '../src/chat/adapters/shared';
import { chooseAiKeys } from '../src/architect/compiler';

describe('N5: a Lead or Contact in WhatId', () => {
  it('is rejected with the fix', () => {
    const p = argProblem({ 'sobject-name': 'Task', body: { Subject: 'x', WhatId: '00Qg5000008th4XEAQ' } })!;
    expect(p).toMatch(/^REJECTED: WhatId "00Qg5000008th4XEAQ" is a Lead/);
    expect(p).toMatch(/go in WhoId/);
    expect(argProblem({ body: { WhatId: '003g500000kKEPJAA4' } })).toMatch(/is a Contact/);
    expect(argProblem({ body: { WhatId: '006g5000009nJfRAAU', WhoId: '00Qg5000008th4XEAQ' } })).toBeNull();
  });

  it('is bounced back before the call is parked for approval', async () => {
    repo.create.mockReset();
    const gated = approvalGate({ orgId: 'o', agentApiName: 'a', sessionId: 's', userId: 'u', audience: 'external' })(
      tool(async () => 'ran', { name: 'createSobjectRecord', description: 'd', schema: z.object({}).passthrough() }),
    );
    const out = String(await gated.invoke({ body: { WhatId: '00Qg5000008th4XEAQ' } }));
    expect(out).toMatch(/^REJECTED/);
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe('N3: the reply language is named per turn', () => {
  it('quotes the latest message', () => {
    expect(latestLanguageNote('Please arrange a callback tomorrow')).toMatch(/same language as the person's latest message: "Please arrange a callback tomorrow"/);
    expect(latestLanguageNote('कृपया कीमत बताइए')).toMatch(/कृपया/);
  });
  it('says nothing for a message with no words', () => {
    expect(latestLanguageNote('👍')).toBeNull();
    expect(latestLanguageNote('45')).toBeNull();
  });
});

describe('N1: the builder chooses a key for each AI node', () => {
  const keys = [
    { Id: 'k_old', EngineType__c: 'openai', IsPreferred__c: false, ValidationStatus__c: 'Success', LastValidatedAt__c: '2026-09-01' },
    { Id: 'k_pref', EngineType__c: 'openai', IsPreferred__c: true, ValidationStatus__c: 'Success', LastValidatedAt__c: '2026-08-01' },
    { Id: 'k_claude', EngineType__c: 'claude', IsPreferred__c: false, ValidationStatus__c: 'Success', LastValidatedAt__c: '2026-09-02' },
  ];
  const conn = { query: async () => ({ records: keys }) } as never;
  beforeEach(() => {});

  it('prefers the org-preferred key of the node\'s provider', async () => {
    const notes: string[] = [];
    const keyFor = await chooseAiKeys(conn, null, notes);
    expect(keyFor('gpt4')).toBe('k_pref');
    expect(keyFor('claude')).toBe('k_claude');
    expect(notes).toEqual([]);
  });

  it('keeps the key already chosen on a rebuilt agent', async () => {
    const keyFor = await chooseAiKeys(conn, 'k_old', []);
    expect(keyFor('gpt4')).toBe('k_old');
  });

  it('says so when there is no key for the provider', async () => {
    const notes: string[] = [];
    const keyFor = await chooseAiKeys(conn, null, notes);
    expect(keyFor('gemini')).toBeNull();
    expect(keyFor('gemini')).toBeNull();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/No active gemini AI key/);
  });
});

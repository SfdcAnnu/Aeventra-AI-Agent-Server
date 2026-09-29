import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';

/**
 * A decided approval is a fact the agent sees: its audit row is replayed
 * into the turn, and calling the same gated tool again answers with the
 * request's state instead of opening another request.
 */
const repo = vi.hoisted(() => ({
  findLatestForCall: vi.fn(),
  create: vi.fn(),
}));
vi.mock('../src/db/chat-approvals.repo', () => ({ ChatApprovalsRepo: repo, stableJson: (v: unknown) => JSON.stringify(v) }));
vi.mock('../src/db/client', () => ({ prisma: {} }));

import { approvalOutcomeMessage, isApprovalOutcome } from '../src/chat/approval-outcome';
import { toLangchainMessages } from '../src/lc/graph-runtime';
import { approvalGate } from '../src/lc/approval-gate';
import { collectFindings } from '../src/lc/specialist-scratch';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const EXECUTED = 'Approved by Ann Admin · deploy(changeId=chg_1) → Executed — {"success":true,"deployId":"0Af1"}';

describe('the approval audit row', () => {
  it('is recognised in the shape approval-audit.ts writes, and nothing else', () => {
    expect(isApprovalOutcome(EXECUTED)).toBe(true);
    expect(isApprovalOutcome('Rejected by Ann · deploy(changeId=chg_1) → Rejected')).toBe(true);
    expect(isApprovalOutcome('[Back from Metadata Expert]')).toBe(false);
    expect(isApprovalOutcome('')).toBe(false);
  });

  it('reads as settled to the model', () => {
    expect(approvalOutcomeMessage(EXECUTED)).toMatch(/^\[APPROVAL OUTCOME\] Approved by Ann Admin/);
    expect(approvalOutcomeMessage(EXECUTED)).toMatch(/it is done/);
    expect(approvalOutcomeMessage('Rejected by Ann · deploy(changeId=chg_1) → Rejected')).toMatch(/rejected that action/);
  });

  it('is replayed into the turn while other System rows stay out', () => {
    const out = toLangchainMessages([
      { role: 'user', content: 'deploy it' },
      { role: 'assistant', content: 'Awaiting approval.' },
      { role: 'system', content: EXECUTED },
      { role: 'system', content: '[Update] screen chrome' },
    ], 'is it done?', []);
    const texts = out.map(m => String(m.content));
    expect(texts.some(t => t.startsWith('[APPROVAL OUTCOME]'))).toBe(true);
    expect(texts.some(t => t.includes('screen chrome'))).toBe(false);
    expect(out.at(-1)?.content).toBe('is it done?');
  });

  it('is handed to a specialist with the other findings', () => {
    const found = collectFindings([new HumanMessage(approvalOutcomeMessage(EXECUTED))] as never, new Set());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/chg_1/);
  });
});

describe('calling a gated tool again', () => {
  const gate = approvalGate({ orgId: 'o', agentApiName: 'a', sessionId: 's', userId: 'u' });
  const deploy = gate(tool(async () => 'ran', { name: 'deploy', description: 'd', schema: z.object({ changeId: z.string() }) }));
  beforeEach(() => { repo.findLatestForCall.mockReset(); repo.create.mockReset(); });

  it('answers with the result of the executed request, and opens no new one', async () => {
    repo.findLatestForCall.mockResolvedValue({ id: 'r1', status: 'Executed', decidedBy: 'u2', decidedAt: new Date('2026-09-28T13:44:00Z'), createdAt: new Date(), resultText: '{"success":true}' });
    const out = await deploy.invoke({ changeId: 'chg_1' });
    expect(out).toMatch(/^ALREADY_EXECUTED/);
    expect(out).toMatch(/"success":true/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('points at the pending request instead of a second one', async () => {
    repo.findLatestForCall.mockResolvedValue({ id: 'r1', status: 'Pending', createdAt: new Date(), decidedAt: null, decidedBy: null, resultText: null });
    const out = await deploy.invoke({ changeId: 'chg_1' });
    expect(out).toMatch(/already awaiting approval as request r1/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('opens a request when nothing prior matches, or the prior one failed', async () => {
    repo.findLatestForCall.mockResolvedValue(null);
    repo.create.mockResolvedValue({ id: 'new1' });
    expect(await deploy.invoke({ changeId: 'chg_1' })).toMatch(/Approval request new1 was created/);
    repo.findLatestForCall.mockResolvedValue({ id: 'r1', status: 'Failed', createdAt: new Date(), decidedAt: new Date(), decidedBy: 'u2', resultText: 'boom' });
    repo.create.mockResolvedValue({ id: 'new2' });
    expect(await deploy.invoke({ changeId: 'chg_1' })).toMatch(/Approval request new2 was created/);
  });
});

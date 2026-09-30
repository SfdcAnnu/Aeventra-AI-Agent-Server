import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

/**
 * The 30 Sep 2026 agent test run: tool errors were recorded as successes,
 * a failed create counted as a write, agents with no tools promised to do
 * things later, and customers were told to press an approval card they
 * could not see. These pin the fixes.
 */
const repo = vi.hoisted(() => ({ findLatestForCall: vi.fn(), create: vi.fn() }));
vi.mock('../src/db/chat-approvals.repo', () => ({ ChatApprovalsRepo: repo, stableJson: (v: unknown) => JSON.stringify(v) }));
vi.mock('../src/db/client', () => ({ prisma: {} }));

import { isToolFailure, isSafeToRetry, toolsUnavailableNotice, specialistFailureNote } from '../src/lc/tool-failure';
import { extractToolCalls, turnHasWrite } from '../src/lc/graph-runtime';
import { approvalGate, approvalAudience } from '../src/lc/approval-gate';
import { isDeleteAction } from '../src/architect/compiler';

const LANGGRAPH_THROWN =
  "Error: MCP tool 'soqlQuery' on server 'salesforce_mcp' returned an error: {\"errorCode\":\"INVALID_FIELD\"}\n Please fix your mistakes.";

describe('what counts as a failed tool call', () => {
  it('catches the shape LangGraph gives a thrown tool, and the built-in actions', () => {
    expect(isToolFailure(LANGGRAPH_THROWN)).toBe(true);
    expect(isToolFailure('Create failed: REQUIRED_FIELD_MISSING')).toBe(true);
    expect(isToolFailure('Update failed: x')).toBe(true);
    expect(isToolFailure('Specialist failed: timeout. Continue without it')).toBe(true);
    expect(isToolFailure('anything', 'error')).toBe(true);
  });

  it('does not flag real answers', () => {
    expect(isToolFailure('{"records":[],"totalSize":0}')).toBe(false);
    expect(isToolFailure('The error rate is low')).toBe(false);
    expect(isToolFailure(undefined)).toBe(false);
  });
});

describe('one retry, only when it is safe', () => {
  it('retries a dropped connection on reads and updates', () => {
    expect(isSafeToRetry('updateSobjectRecord', 'FetchError: request to https://x failed, reason: read ECONNRESET')).toBe(true);
    expect(isSafeToRetry('soqlQuery', 'socket hang up')).toBe(true);
  });
  it('never repeats a create after a reset (it may have landed), but does when nothing was sent', () => {
    expect(isSafeToRetry('createSobjectRecord', 'read ECONNRESET')).toBe(false);
    expect(isSafeToRetry('createSobjectRecord', 'connect ECONNREFUSED 1.2.3.4:443')).toBe(true);
  });
  it('never retries a validation error', () => {
    expect(isSafeToRetry('soqlQuery', 'INVALID_FIELD: No such column')).toBe(false);
  });
});

describe('an agent without its tools', () => {
  it('is told not to promise anything', () => {
    const n = toolsUnavailableNotice(['salesforce_mcp'])!;
    expect(n).toMatch(/TOOLS UNAVAILABLE RIGHT NOW: salesforce_mcp/);
    expect(n).toMatch(/Do NOT promise to do it later/);
    expect(n).toMatch(/logged, saved, scheduled or followed up/);
    expect(toolsUnavailableNotice([])).toBeNull();
  });

  it("a specialist's failed lookup reaches its caller as an error, not 'not found'", () => {
    const note = specialistFailureNote([{ name: 'soqlQuery', output: LANGGRAPH_THROWN }])!;
    expect(note).toMatch(/HELPER ERROR/);
    expect(note).toMatch(/a failed lookup is not "not found"/);
    expect(specialistFailureNote([])).toBeNull();
  });
});

describe('the transcript and the write guard', () => {
  const call = (name: string, id: string) => new AIMessage({ content: '', tool_calls: [{ name, id, args: {} }] });

  it('records a thrown MCP error as isError', () => {
    const out = extractToolCalls(
      [call('soqlQuery', 'c1'), new ToolMessage({ content: LANGGRAPH_THROWN, tool_call_id: 'c1' })],
      { tools: [], unavailable: [], serverByTool: new Map(), close: async () => {} },
    );
    expect(out[0].isError).toBe(true);
  });

  it('does not count a failed create as a write', () => {
    expect(turnHasWrite([call('createSobjectRecord', 'c1'), new ToolMessage({ content: LANGGRAPH_THROWN, tool_call_id: 'c1' })])).toBe(false);
    expect(turnHasWrite([call('createSobjectRecord', 'c2'), new ToolMessage({ content: '{"id":"00Q1","success":true}', tool_call_id: 'c2' })])).toBe(true);
  });
});

describe('approval wording follows who reads it', () => {
  beforeEach(() => {
    repo.findLatestForCall.mockReset().mockResolvedValue(null);
    repo.create.mockReset().mockResolvedValue({ id: 'ap1' });
  });
  const writeTool = () => tool(async () => 'ran', { name: 'createSobjectRecord', description: 'd', schema: z.object({}).passthrough() });
  const meta = { orgId: 'o', agentApiName: 'a', sessionId: 's', userId: 'u' };

  it('tells a customer the team is confirming, never about a card', async () => {
    const out = String(await approvalGate({ ...meta, audience: 'external' })(writeTool()).invoke({}));
    expect(out).toMatch(/^PENDING_APPROVAL/);
    expect(out).toMatch(/team is confirming it/);
    expect(out).not.toMatch(/card with/);
    // The audience is not an approval-row column.
    expect(repo.create.mock.calls[0][0]).not.toHaveProperty('audience');
  });

  it('keeps the card wording for employees', async () => {
    const out = String(await approvalGate({ ...meta, audience: 'internal' })(writeTool()).invoke({}));
    expect(out).toMatch(/approval card with/);
  });

  it('decides the audience from the channel or the agent', () => {
    expect(approvalAudience({ senderPhone: '+911234' }, {})).toBe('external');
    expect(approvalAudience({ channel: 'whatsapp' }, {})).toBe('external');
    expect(approvalAudience({}, { customerFacing: true })).toBe('external');
    expect(approvalAudience({}, {})).toBe('internal');
  });
});

describe('deletes are always gated by the compiler', () => {
  it('recognises a delete by operation or by name', () => {
    expect(isDeleteAction(undefined, 'delete')).toBe(true);
    expect(isDeleteAction('deleteSobjectRecord', undefined)).toBe(true);
    expect(isDeleteAction('createSobjectRecord', 'create')).toBe(false);
  });
});

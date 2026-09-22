import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted above every const, so the spy has to be hoisted too.
const { runChatTurn } = vi.hoisted(() => ({
  runChatTurn: vi.fn().mockResolvedValue({ assistantText: 'done', toolCalls: [] }),
}));
vi.mock('../src/chat/chat-engine', () => ({ runChatTurn }));
vi.mock('../src/chat/adapters/connectors-from-agent', () => ({
  buildConnectorInputsFromAgent: vi.fn().mockResolvedValue([]),
}));

import { runHeadlessAiStep } from '../src/chat/headless';

/**
 * A Flow-triggered agent used to run on a different engine from the same
 * agent in chat. headless.ts called runClaudeAdapter / runOpenAiAdapter,
 * which handed the tool loop to the provider — `mcp_servers` on Anthropic,
 * `require_approval: 'never'` on OpenAI. The approval gate, the allow-list
 * and the budget all live in the runtime, so none of them applied.
 *
 * These hold the routing. If one fails, automation has drifted off the
 * runtime again and gated writes are running unsupervised.
 */
const node = (id: string, nodeSubType: string) => ({
  id, name: `${nodeSubType} node`, nodeType: 'ai', nodeSubType,
  config: { instruction: 'Qualify this lead' },
  positionX: 0, positionY: 0, sortOrder: 0, isEnabled: true,
});

const ctx = (nodes: ReturnType<typeof node>[]) => ({
  agent: { id: 'a1', apiName: 'lead_agent', nodes },
  orgId: '00Dxxx', userId: '005xxx', recordId: '00Qxxx',
  correlationId: 'corr-1', engineOverride: undefined,
  inputPayload: {}, state: new Map(),
  conn: {}, interpolate: (t: string) => t,
}) as never;

describe('a flow AI step runs on the chat runtime', () => {
  beforeEach(() => runChatTurn.mockClear());

  it('calls runChatTurn, not a provider adapter', async () => {
    await runHeadlessAiStep(ctx([node('n1', 'claude')]), node('n1', 'claude') as never);
    expect(runChatTurn).toHaveBeenCalledOnce();
  });

  it('names the node the walker reached, not whichever ai node is first', async () => {
    // A canvas with two AI nodes: running the first would silently use
    // another node's model, instructions and guardrails.
    const nodes = [node('first', 'claude'), node('second', 'gpt4')];
    await runHeadlessAiStep(ctx(nodes), nodes[1] as never);
    expect(runChatTurn.mock.calls[0][0].aiNodeId).toBe('second');
  });

  it('runs Gemini, which the adapter path refused outright', async () => {
    // "Gemini orchestrator with tool catalogs is not wired yet" was a
    // consequence of Managed MCP, which Google does not offer — never a
    // limitation of the model.
    await runHeadlessAiStep(ctx([node('g', 'gemini')]), node('g', 'gemini') as never);
    expect(runChatTurn).toHaveBeenCalledOnce();
  });

  it('sends no chat history — a trigger run has none', async () => {
    await runHeadlessAiStep(ctx([node('n1', 'claude')]), node('n1', 'claude') as never);
    expect(runChatTurn.mock.calls[0][0].history).toEqual([]);
  });

  it('still asks for the score tail the flow engine parses', async () => {
    await runHeadlessAiStep(ctx([node('n1', 'claude')]), node('n1', 'claude') as never);
    expect(runChatTurn.mock.calls[0][0].newUserMessage).toContain('"score"');
  });

  it('carries the trigger record through as the turn context', async () => {
    await runHeadlessAiStep(ctx([node('n1', 'claude')]), node('n1', 'claude') as never);
    expect(runChatTurn.mock.calls[0][0].context.recordContextId).toBe('00Qxxx');
  });
});

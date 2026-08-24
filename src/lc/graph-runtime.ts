/**
 * graph-runtime — the LangGraph chat engine. Drop-in replacement for the
 * original chat-engine.ts + both provider adapters (~1,000 lines of
 * hand-rolled request/wire/loop code → one compiled StateGraph).
 *
 * PRESERVED CONTRACT — everything outside this file is unchanged:
 *   runChatTurn(req: ChatTurnRequest) → ChatTurnResult, same shapes, same
 *   routes, same WS gateway, same Apex. Salesforce stays the system of
 *   record; memory (summary/facts), guardrails accounting, session titles
 *   and persistence all work exactly as in the original server.
 *
 * PRESERVED SEMANTICS (ported, not reinterpreted):
 *   - fromPort:'tool' wiring via subagent-router.ts (reused verbatim)
 *   - subagents-as-handoff-tools; a subagent's reply IS the turn's reply
 *   - hard 2-tier depth cap (subagents get no handoff tools)
 *   - subagent failure degrades to an apology, preserving billed tokens
 *   - memory assembly before the call, async summarize after the reply
 *   - narration-only guard (structurally rarer here: the ReAct cycle keeps
 *     going after tool calls until the model produces real text)
 *
 * CHANGED BY DESIGN:
 *   - Tools execute CLIENT-side (lc/mcp-tools.ts) instead of provider-side;
 *     one code path for every provider, Gemini included for free.
 */
import {
  Annotation,
  Command,
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { z } from 'zod';
import { logger } from '../logger';
import { InstallsRepo } from '../db/installs.repo';
import type { AgentDefinition, AgentNode, AgentAction } from '../types';
import { buildGraph } from '../orchestrator/graph';
import {
  resolveTopLevelToolsAndSubagents,
  resolveSubagentActions,
  toSyntheticAiNode,
  type HandoffToolDef,
} from '../chat/subagent-router';
import { buildSystemPrompt, resolveMcpServers } from '../chat/adapters/shared';
import { loadAttachments, type LoadedAttachment } from '../chat/adapters/attachments';
import { loadSessionMemory, assembleMemory, maybeUpdateMemoryAsync } from '../chat/memory';
import { generateSessionTitleAsync } from '../chat/title-generator';
import { buildChatModel } from './models';
import { loadMcpTools, type LoadedMcpTools } from './mcp-tools';
import type {
  ChatHistoryMessage,
  ChatTurnRequest,
  ChatTurnResult,
  ConnectorInput,
  ToolCallSummary,
} from '../chat/adapters/types';

const TITLE_TRIGGER_TURN = 3;
const MAX_GRAPH_STEPS = 24; // recursion cap: router+tools cycles per turn

const TurnState = Annotation.Root({
  ...MessagesAnnotation.spec,
  handoffNodeId: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
});

export async function runChatTurn(req: ChatTurnRequest): Promise<ChatTurnResult> {
  const aiNode = req.agent.nodes.find(n => n.nodeType === 'ai') ?? null;
  if (!aiNode) throw new Error('Agent has no AI orchestrator node — cannot run chat mode.');

  const install = await InstallsRepo.findByOrgId(req.context.orgId);
  if (!install?.sfAccessToken) {
    throw new Error('Org has no Salesforce tokens. Admin must run Synapse Setup first.');
  }

  const graph = buildGraph(req.agent);
  const { topLevelActions, handoffTools } = resolveTopLevelToolsAndSubagents(req.agent, graph, aiNode);

  // Memory read path — identical to the original (see chat/memory.ts).
  const memory = await loadSessionMemory(req.context.orgId, req.sessionId);
  const assembled = assembleMemory(req.history, memory);

  logger.info({
    orgId: req.context.orgId,
    agentApiName: req.agent.apiName,
    aiNodeSubType: aiNode.nodeSubType,
    topLevelActionCount: topLevelActions.length,
    subagentCount: handoffTools.length,
    engine: 'langgraph',
  }, 'chat_turn_dispatch');

  // ── Tools: resolve servers (top-level actions merged in, exactly as the
  // original chat-engine did) and load them as LangChain tools.
  const topConnectors = mergeActionsIntoConnectors(req.connectors, topLevelActions);
  const servers = await resolveMcpServers({ ...req, connectors: topConnectors }, aiNode, install.sfAccessToken);
  const loaded = await loadMcpTools(servers);

  try {
    const { model: routerBase, modelName } = buildChatModel(
      aiNode.nodeSubType,
      (aiNode.config as { model?: string })?.model,
      req.engineOverride,
    );

    const systemPrompt = await buildSystemPrompt(
      req.agent, aiNode, req.context, req.newUserMessage, req.engineOverride, req.memoryPreamble ?? assembled.preamble,
    );

    const attachments = (req.attachments && req.attachments.length > 0)
      ? await loadAttachments(req.context.orgId, req.attachments)
      : [];

    const baseMessages = toLangchainMessages(assembled.history, req.newUserMessage, attachments);

    // Handoff tools — same slugged names/descriptions subagent-router built.
    const handoffLcTools = handoffTools.map(h =>
      tool(async () => `Handing off to ${h.name}.`, {
        name: h.name,
        description: h.description,
        schema: z.object({}),
      }),
    );

    if (!routerBase.bindTools) throw new Error(`Model for ${aiNode.nodeSubType} does not support tool binding.`);
    const routerModel = routerBase.bindTools([...loaded.tools, ...handoffLcTools]);
    const handoffByName = new Map(handoffTools.map(h => [h.name, h]));

    // ── Router node: answer → END; handoff → mark + END (the subagent turn
    // runs as its own graph below, mirroring the original two-call shape);
    // tool calls → ToolNode → back here.
    const routerNode = async (state: typeof TurnState.State) => {
      const response = (await routerModel.invoke([
        new SystemMessage(systemPrompt),
        ...state.messages,
      ])) as AIMessage;

      const calls = response.tool_calls ?? [];
      const handoff = calls.find(c => handoffByName.has(c.name));
      if (handoff) {
        const matched = handoffByName.get(handoff.name)!;
        return new Command({
          goto: END,
          update: { messages: [response], handoffNodeId: matched.subagentNodeId },
        });
      }
      if (calls.length > 0) {
        return new Command({ goto: 'tools', update: { messages: [response] } });
      }
      return new Command({ goto: END, update: { messages: [response] } });
    };

    const compiled = new StateGraph(TurnState)
      .addNode('router', routerNode, { ends: [END, 'tools'] })
      .addNode('tools', new ToolNode(loaded.tools))
      .addEdge(START, 'router')
      .addEdge('tools', 'router')
      .compile();

    const t0 = Date.now();
    let state = await compiled.invoke(
      { messages: baseMessages },
      { recursionLimit: MAX_GRAPH_STEPS },
    );

    let usedModel = modelName;
    let activeSubagentName: string | null = null;

    // ── Subagent handoff: second graph as that subagent's own turn — its
    // own prompt/model/tool subset; no handoff tools (the depth cap).
    if (state.handoffNodeId) {
      const subagentNode = req.agent.nodes.find(n => n.id === state.handoffNodeId);
      if (!subagentNode) {
        logger.error({ orgId: req.context.orgId, nodeId: state.handoffNodeId }, 'lc_handoff_target_missing');
      } else {
        activeSubagentName = subagentNode.name;
        try {
          const sub = await runSubagentTurn(req, aiNode, subagentNode, graph, install.sfAccessToken, assembled, baseMessages);
          usedModel = sub.modelName;
          state = { ...state, messages: [...state.messages, ...sub.messages], handoffNodeId: state.handoffNodeId };
        } catch (err) {
          // Same degrade-don't-500 stance as the original: top-level tokens
          // are already real/billed; give the customer a real sentence.
          logger.error({ orgId: req.context.orgId, err: err instanceof Error ? err.message : err }, 'lc_subagent_dispatch_failed');
          const apology = new AIMessage("Sorry, I couldn't complete that just now — could you try again in a moment?");
          state = { ...state, messages: [...state.messages, apology] };
        }
      }
    }

    // ── Narration guard: LangGraph's cycle already refuses to stop on a
    // tool call, but a model can still emit whitespace-only text. One
    // bounded nudge, same wording as the original.
    let assistantText = lastAssistantText(state.messages);
    if (!assistantText) {
      logger.warn({ orgId: req.context.orgId }, 'lc_narration_only_continuation');
      const followup = (await routerModel.invoke([
        new SystemMessage(systemPrompt),
        ...state.messages,
        new HumanMessage('Continue — that was not a complete reply, the customer cannot see it. Finish responding now with a real answer based on what you just found or did.'),
      ])) as AIMessage;
      state = { ...state, messages: [...state.messages, followup] };
      assistantText = lastAssistantText(state.messages);
    }

    const { tokensIn, tokensOut } = sumUsage(state.messages);
    const toolCalls = extractToolCalls(state.messages, loaded);

    logger.info({ orgId: req.context.orgId, tokensIn, tokensOut, toolCallCount: toolCalls.length, ms: Date.now() - t0 }, 'lc_turn_complete');

    const result: ChatTurnResult = {
      status: 'complete',
      assistantText,
      toolCalls,
      modelUsed: usedModel,
      tokensIn,
      tokensOut,
      ...(activeSubagentName !== null ? { activeTopicName: activeSubagentName } : {}),
    };

    // Post-reply hooks — identical to the original server.
    maybeUpdateMemoryAsync({
      orgId: req.context.orgId,
      sessionId: req.sessionId,
      history: req.history,
      newUserMessage: req.newUserMessage,
      assistantText: result.assistantText,
      engineOverride: req.engineOverride,
      memory,
    });
    const turnCount = req.history.filter(m => m.role === 'user').length + 1;
    const engineType = aiNode.nodeSubType === 'gpt4' ? 'openai' : aiNode.nodeSubType;
    if (turnCount === TITLE_TRIGGER_TURN && result.assistantText && (engineType === 'openai' || engineType === 'claude' || engineType === 'gemini')) {
      generateSessionTitleAsync({
        orgId: req.context.orgId,
        sessionId: req.sessionId,
        engineType,
        history: req.history,
        newUserMessage: req.newUserMessage,
        newAssistantMessage: result.assistantText,
        engineOverride: req.engineOverride,
      });
    }

    return result;
  } finally {
    await loaded.close();
  }
}

/** The chosen subagent's own turn: own prompt/model, own tool subset (its
 *  attached tool nodes merged into the connectors), no handoffs. */
async function runSubagentTurn(
  req: ChatTurnRequest,
  topAiNode: AgentNode,
  subagentNode: AgentNode,
  graph: ReturnType<typeof buildGraph>,
  sfAccessToken: string,
  assembled: { preamble: string | null },
  baseMessages: BaseMessage[],
): Promise<{ messages: BaseMessage[]; modelName: string }> {
  const synthetic = toSyntheticAiNode(subagentNode, topAiNode);
  const subActions = resolveSubagentActions(graph, subagentNode);
  const subConnectors = mergeActionsIntoConnectors(req.connectors, subActions);
  const servers = await resolveMcpServers({ ...req, connectors: subConnectors }, synthetic, sfAccessToken);
  const loaded = await loadMcpTools(servers);
  try {
    const { model, modelName } = buildChatModel(
      synthetic.nodeSubType,
      (synthetic.config as { model?: string })?.model,
      req.engineOverride,
    );
    const systemPrompt = await buildSystemPrompt(
      req.agent, synthetic, req.context, req.newUserMessage, req.engineOverride, req.memoryPreamble ?? assembled.preamble,
    );
    if (!model.bindTools) throw new Error(`Model for ${synthetic.nodeSubType} does not support tool binding.`);
    const bound = model.bindTools(loaded.tools);

    const subNode = async (state: typeof MessagesAnnotation.State) => {
      const response = (await bound.invoke([new SystemMessage(systemPrompt), ...state.messages])) as AIMessage;
      return { messages: [response] };
    };
    const shouldContinue = (state: typeof MessagesAnnotation.State) => {
      const last = state.messages[state.messages.length - 1];
      return last instanceof AIMessage && (last.tool_calls?.length ?? 0) > 0 ? 'tools' : END;
    };
    const compiled = new StateGraph(MessagesAnnotation)
      .addNode('agent', subNode)
      .addNode('tools', new ToolNode(loaded.tools))
      .addEdge(START, 'agent')
      .addConditionalEdges('agent', shouldContinue, ['tools', END])
      .addEdge('tools', 'agent')
      .compile();

    const out = await compiled.invoke({ messages: baseMessages }, { recursionLimit: MAX_GRAPH_STEPS });
    return { messages: out.messages.slice(baseMessages.length), modelName };
  } finally {
    await loaded.close();
  }
}

// ── Mapping helpers ─────────────────────────────────────────────────

function toLangchainMessages(
  history: ChatHistoryMessage[],
  newUserMessage: string,
  attachments: LoadedAttachment[],
): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (const m of history) {
    if (m.role === 'system' || m.role === 'tool') continue; // same rule as both original adapters
    out.push(m.role === 'assistant' ? new AIMessage(m.content) : new HumanMessage(m.content));
  }
  if (attachments.length === 0) {
    out.push(new HumanMessage(newUserMessage || '(no message)'));
    return out;
  }
  const parts: Array<Record<string, unknown>> = [];
  if (newUserMessage.trim()) parts.push({ type: 'text', text: newUserMessage });
  for (const att of attachments) {
    if (att.kind === 'image') {
      parts.push({ type: 'image_url', image_url: { url: `data:${att.mimeType};base64,${att.base64}` } });
    } else if (att.kind === 'pdf') {
      parts.push({ type: 'file', source_type: 'base64', mime_type: 'application/pdf', data: att.base64 });
    } else if (att.kind === 'text') {
      const decoded = Buffer.from(att.base64, 'base64').toString('utf8');
      parts.push({ type: 'text', text: `[Attached file: ${att.fileName}]\n\`\`\`\n${decoded}\n\`\`\`` });
    } else {
      parts.push({ type: 'text', text: `[Attached file: ${att.fileName} — unsupported type, skipped]` });
    }
  }
  out.push(new HumanMessage({ content: parts as never }));
  return out;
}

function lastAssistantText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m instanceof AIMessage) {
      const text = typeof m.content === 'string'
        ? m.content
        : (m.content as Array<{ type?: string; text?: string }>).map(c => c.text ?? '').join('');
      if (text.trim()) return text.trim();
    }
  }
  return '';
}

function sumUsage(messages: BaseMessage[]): { tokensIn: number; tokensOut: number } {
  let tokensIn = 0;
  let tokensOut = 0;
  for (const m of messages) {
    if (m instanceof AIMessage && m.usage_metadata) {
      tokensIn += m.usage_metadata.input_tokens ?? 0;
      tokensOut += m.usage_metadata.output_tokens ?? 0;
    }
  }
  return { tokensIn, tokensOut };
}

/** Pair each AIMessage tool call with its ToolMessage result — same
 *  ToolCallSummary shape Apex/the chat panel already consume. */
function extractToolCalls(messages: BaseMessage[], loaded: LoadedMcpTools): ToolCallSummary[] {
  const resultsByCallId = new Map<string, ToolMessage>();
  for (const m of messages) {
    if (m instanceof ToolMessage && m.tool_call_id) resultsByCallId.set(m.tool_call_id, m);
  }
  const out: ToolCallSummary[] = [];
  for (const m of messages) {
    if (!(m instanceof AIMessage)) continue;
    for (const call of m.tool_calls ?? []) {
      if (!loaded.serverByTool.has(call.name)) continue; // skip handoff pseudo-tools
      const result = call.id ? resultsByCallId.get(call.id) : undefined;
      const output = result
        ? (typeof result.content === 'string' ? result.content : JSON.stringify(result.content))
        : undefined;
      out.push({
        id: call.id ?? '',
        name: call.name,
        input: (call.args as Record<string, unknown>) ?? {},
        output,
        isError: result?.status === 'error',
        serverName: loaded.serverByTool.get(call.name),
      });
    }
  }
  return out;
}

/** Verbatim port of chat-engine.ts's private helper — folds resolved tool-
 *  node actions into the connectors payload (MCP names → allowedTools,
 *  Apex/Flow → customTools). */
function mergeActionsIntoConnectors(
  connectors: ConnectorInput[] | undefined,
  actions: AgentAction[],
): ConnectorInput[] | undefined {
  if (actions.length === 0 || !connectors) return connectors;
  const sfIndex = connectors.findIndex(c => c.provider === 'salesforce_mcp');
  if (sfIndex === -1) return connectors;

  const list = connectors.map(c => ({ ...c, allowedTools: [...c.allowedTools], customTools: c.customTools ? [...c.customTools] : [] }));
  const sf = list[sfIndex];

  for (const action of actions) {
    if (action.actionType === 'MCP') {
      if (sf.allowedTools.length > 0 && !sf.allowedTools.includes(action.toolName)) {
        sf.allowedTools.push(action.toolName);
      }
      continue;
    }
    const type = action.actionType === 'Apex' ? 'apex' : 'flow';
    if (!sf.customTools!.some(t => t.type === type && t.name === action.toolName)) {
      sf.customTools!.push({ type, name: action.toolName, label: action.name });
    }
  }
  return list;
}

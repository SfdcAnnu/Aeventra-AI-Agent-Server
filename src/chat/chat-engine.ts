/**
 * chat-engine (LangChain edition) — same module path and export surface as
 * the original server's dispatcher, now delegating to the LangGraph runtime
 * in ../lc/graph-runtime.ts. Every caller (routes/chat.routes.ts,
 * ws/gateway.ts, chat/headless.ts) is untouched: same runChatTurn signature,
 * same ChatTurnRequest/Result shapes, same error behavior.
 *
 * The original hand-rolled provider adapters (adapters/claude.ts,
 * adapters/openai.ts) remain in the tree ONLY because the agent generator
 * and builder copilot still reuse their low-level callOpenAi/callClaude
 * helpers — chat traffic never touches them here.
 */
export { runChatTurn } from '../lc/graph-runtime';
export type { ChatTurnRequest, ChatTurnResult, ChatHistoryMessage } from './adapters/types';

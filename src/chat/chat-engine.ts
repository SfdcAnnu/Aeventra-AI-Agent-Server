/**
 * chat-engine (LangChain edition) — same module path and export surface as
 * the original server's dispatcher, now delegating to the LangGraph runtime
 * in ../lc/graph-runtime.ts. Every caller (routes/chat.routes.ts,
 * ws/gateway.ts, chat/headless.ts) is untouched: same runChatTurn signature,
 * same ChatTurnRequest/Result shapes, same error behavior.
 *
 * Phase 7: the runtime is wrapped in turn idempotency HERE — the one choke
 * point every transport (HTTP, WebSocket, headless flow runs) goes through
 * — so webhook double-fires and Apex timeout-retries share one execution
 * instead of billing two.
 *
 * The original hand-rolled provider adapters (adapters/claude.ts,
 * adapters/openai.ts) remain in the tree ONLY for Trigger-mode ai steps
 * (chat/headless.ts) — chat traffic never touches them here.
 */
import { runChatTurn as runLangGraphTurn } from '../lc/graph-runtime';
import { withTurnIdempotency } from './turn-idempotency';

export const runChatTurn = withTurnIdempotency(runLangGraphTurn);
export type { ChatTurnRequest, ChatTurnResult, ChatHistoryMessage } from './adapters/types';

# Archon Server — LangChain/LangGraph Edition

A complete, deployable replica of the Archon Node server with the chat AI
core rebuilt on **LangChain** (models, tools) and **LangGraph** (the agent
loop). The original `server/` stays in production untouched; this codebase
exists so the move to the framework is a **URL switch, not a rewrite**.

## The contract is identical

Same HTTP routes, same WebSocket protocol, same request/response shapes,
same `Bearer SessionKey__c` auth, same Prisma schema (points at the same
database), same Salesforce persistence (`ChatSession__c`/`ChatMessage__c`,
guardrails accounting, memory fields, feedback). **Apex and the React app
need zero changes** — deploy this next to the original and flip
`SynapseConfig.ServerUrl__c` (or the Render service) to cut over; flip back
to roll back.

## What is LangChain/LangGraph vs. carried over

| Layer | Status |
|---|---|
| Chat turn engine (router → tools → subagent handoff) | **LangGraph StateGraph** (`src/lc/graph-runtime.ts`) — replaces `chat-engine.ts` + both ~400-line provider adapters |
| Model providers | **LangChain chat models** (`src/lc/models.ts`) — OpenAI, Anthropic, **and Gemini** (which the original never implemented) through one interface |
| Tool execution | **Client-side MCP** (`src/lc/mcp-tools.ts` via `@langchain/mcp-adapters`) — the architectural flip: the original had each model provider connect to MCP servers itself; here the server is the MCP client and LangGraph's ToolNode executes calls. Same servers, same tokens, same allowedTools, same `?custom=` Apex/Flow tools |
| Graph semantics | **Ported verbatim** — `subagent-router.ts` reused as-is: `fromPort:'tool'` wiring, handoff tools from routingDescription, 2-tier depth cap, subagent-answers-the-user, degrade-don't-500 on subagent failure |
| Memory (summary/facts, zero-latency async) | Carried over unchanged (`chat/memory.ts`) — already the right design |
| System prompt, KB retrieval, attachments | Carried over (`chat/adapters/shared.ts`, `attachments.ts`) |
| Routes, WS gateway + tickets, auth, OAuth, DB repos, guardrails, KB, built-in MCP servers, run poller | Carried over verbatim — framework-agnostic plumbing LangChain does not replace |
| Agent generator + copilot | Carried over (still direct OpenAI Responses API; port to LangChain structured output = phase 2) |
| Trigger-mode orchestrator (`orchestrator/engine.ts`) | Carried over (already a deterministic graph walker; re-basing it on LangGraph = phase 2) |

## Behavior differences to know about

- **One code path for all providers.** The Claude/OpenAI adapter divergence
  (policy-violation handling, continuation contracts, narration guards) is
  gone; LangGraph's cycle structurally keeps going after tool calls until
  real text exists, so the narration-only bug class mostly disappears.
- **Tool calls round-trip through this server** instead of provider-side
  execution: slightly more per-call latency (~100–300ms per MCP session
  init), full visibility/control (a future hard data-boundary enforcement
  layer can inspect every call before it executes — impossible in the
  provider-hosted model).
- **Gemini chat works** — `nodeSubType: 'gemini'` no longer throws.
- Token counts come from LangChain `usage_metadata`, summed across every
  model call in the turn (router + tools cycles + subagent), preserving the
  guardrails accounting contract.

## Run it

```bash
npm install
npm run build        # prisma generate
npm run lint         # tsc --noEmit — GREEN in this edition (fixed the
                     # module/moduleResolution conflict the original carries)
npm start            # prisma migrate deploy && tsx src/index.ts
```

Same env vars as the original server (`DATABASE_URL`, `SESSION_SECRET`,
`SF_CLIENT_ID/SECRET`, `SERVER_PUBLIC_URL`, `ENCRYPTION_KEY`, …). Point
`DATABASE_URL` at the same Postgres as the original — the schema is
identical and only one server serves traffic at a time.

## Cutover plan

1. Create a second Render service from this codebase (own repo or subtree),
   same env vars as the original service.
2. Smoke it directly: `/health`, then a real chat turn via a test agent by
   temporarily pointing `SynapseConfig.ServerUrl__c` at it in a sandbox.
3. Cut over per-org by switching `ServerUrl__c`; the original stays warm as
   instant rollback.
4. Phase 2 (optional, after cutover confidence): generator/copilot on
   LangChain structured output; trigger-mode on LangGraph; PostgresSaver
   checkpointing as a durability layer (Salesforce remains system of record).

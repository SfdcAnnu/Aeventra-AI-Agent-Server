/** Shared types across chat adapters. */
import type { AgentDefinition } from '../../types';

export interface ChatHistoryMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolCallsJson?: string | null;
  toolResultsJson?: string | null;
  toolCallId?: string | null;
}

export interface AttachmentInput {
  contentDocumentId: string;
  contentVersionId?: string;   // when present, skips the metadata SOQL lookup
  fileName?:         string;
  mimeType?:         string;
  fileType?:         string;
  fileExtension?:    string;
}

/** Per-connector config sent from Salesforce each turn — SF owns this. */
export interface ConnectorInput {
  provider:     string;          // ConnectorCatalog__mdt DeveloperName, e.g. 'salesforce_mcp'
  mcpServerUrl: string;          // base URL, no /mcp suffix
  allowedTools: string[];        // admin's tool selection; empty = all tools
  connectorId?: string | null;   // Node-side Connector row id (token lookup)
  accessMode?: string | null;    // salesforce_mcp only: 'Org' | 'PerUser'
  customTools?: Array<{ type: string; name: string; label?: string | null }> | null; // org's own Apex actions / Flows
  /** 'catalog' (default): a tool catalog node — its allowedTools are the toolset.
   *  'nodes': derived from tool nodes alone — strictly scoped per node (connector-scope.ts). */
  scope?: 'catalog' | 'nodes' | null;
  /** Extra request headers for this server (the metadata server's instance-URL hint). */
  headers?: Record<string, string> | null;
}

export interface EngineOverrideInput {
  engineType?:   string | null;
  apiKey?:       string | null;
  endpoint?:     string | null;
  defaultModel?: string | null;
  connectionId?: string | null;
}

/** One thing the agent started or finished, reported while the turn is
 *  still running (lc/stage-events.ts). Advisory: a client that asked for
 *  none behaves exactly as before, and a sink that throws or refuses
 *  costs a label, never a reply. */
export interface StageUpdate {
  state: 'start' | 'end';
  /** The tool the model called, as the model named it. */
  name: string;
  /** Present on 'end': how long that call took. */
  ms?: number;
  /** Set when the call ran inside a specialist rather than at the root. */
  via?: 'specialist';
  /** The call failed, was refused, or is parked awaiting approval. */
  isError?: boolean;
}

/** Everything a turn can report while it runs.
 *
 *  Text is an accelerant, never the record: the turn result always carries
 *  the complete reply and the browser renders that over anything streamed.
 *  That is what lets 'reset' be a complete answer to any mid-stream
 *  trouble — a tool call that made the pass irrelevant, a reader too slow
 *  to keep up, a provider that stopped streaming. */
export type TurnEvent =
  | ({ kind: 'stage' } & StageUpdate)
  | { kind: 'text'; delta: string }
  | { kind: 'reset' };

export type TurnSink = (event: TurnEvent) => void;
export type StageSink = (update: StageUpdate) => void;

export interface ChatTurnRequest {
  agent: AgentDefinition;
  sessionId: string;
  history: ChatHistoryMessage[];
  newUserMessage: string;
  attachments?: AttachmentInput[];
  engineOverride?: EngineOverrideInput;
  connectors?: ConnectorInput[];
  /** AgentDefinition__c.DebugMode__c — when true, adapters capture the raw
   *  request/response JSON for every provider call this turn (see
   *  ChatTurnResult.debugRequest/debugResponse). Off by default; storing
   *  this on every turn adds real Salesforce field storage, so it's opt-in
   *  per agent, not a global flag. */
  debugMode?: boolean;
  /** Set by chat-engine.ts from session memory (memory.ts): the SESSION
   *  FACTS + CONVERSATION SO FAR blocks. Adapters splice it into the system
   *  prompt via buildSystemPrompt — never send it as a history message. */
  memoryPreamble?: string | null;
  /** The turn that follows an approved action: newUserMessage is empty and
   *  the runtime runs on the shared continuation text instead (connector-scope.ts). */
  continuation?: { toolName: string; resultText: string } | null;
  /** How the turn arrived. The Apex request path cannot wait past its
   *  callout limit, so its turns keep the short time ceiling; a websocket
   *  turn has no such caller and may run longer. Absent = HTTP. */
  transport?: 'http' | 'ws';
  /** Live narration of this turn, for a caller that can deliver it. Only
   *  the websocket path supplies one, and only when the browser asked. */
  onEvent?: TurnSink | null;
  context: {
    orgId: string;
    userId: string;
    recordContextId?: string | null;
    recordContextType?: string | null;
  };
}

/** Token usage for ONE model within a single turn.
 *
 *  A turn is not one model call. The router answers on the root node's
 *  model, a specialist runs on its own, and utility passes (memory
 *  summariser, title generator) run on a cheap model — all inside the same
 *  turn. Reporting one `modelUsed` against the turn's whole token total
 *  mis-attributes every multi-model turn, so the breakdown travels
 *  alongside it. */
export interface ModelUsage {
  model: string;
  /** Which parts of the turn ran on this model — router, subagent,
   *  narration_followup, guardrail_regen. Ordered by first appearance. */
  stages: string[];
  calls: number;
  tokensIn: number;
  tokensOut: number;
  /** Prompt-cache hits, already included in tokensIn. Providers bill these
   *  far cheaper, so they are broken out rather than hidden. */
  cacheRead: number;
}

export interface ToolCallSummary {
  id:      string;
  name:    string;
  input:   Record<string, unknown>;
  output?: unknown;
  isError?: boolean;
  serverName?: string; // which connector/MCP server this call went through
  /** For a call into a specialist (ask_*): the tool calls the specialist
   *  made in its own turn, so a client can show the work, not only the
   *  hand-off. One level — specialists have no specialists. */
  nested?: ToolCallSummary[];
}

/** A tool call the model made outside its connector's configured allowedTools. */
export interface PolicyViolation {
  serverName:   string;
  tool:         string;
  allowedTools: string[];
}

export interface ChatTurnResult {
  status: 'complete';
  assistantText: string;
  toolCalls: ToolCallSummary[];
  /** The model that produced the customer-facing answer. Kept for the
   *  existing ChatMessage__c.ModelUsed__c column; `usage` is the accurate
   *  per-model breakdown of the SAME turn. */
  modelUsed: string;
  tokensIn: number;
  tokensOut: number;
  /** Per-model split of tokensIn/tokensOut above. Sums back to them. */
  usage?: ModelUsage[];
  /** Wall-clock time for the whole turn, server-side. */
  latencyMs?: number;
  // Only ever populated for adapters that can't hard-block tool calls
  // (Claude's Managed MCP today — see claude.ts). Empty/undefined means
  // either no restriction was configured, or the provider enforces it
  // server-side already (OpenAI).
  policyViolations?: PolicyViolation[];
  /** Set by chat-engine.ts (not the adapters) — the subagent active for
   *  this turn, if any (field name kept from the old Topics model so Apex's
   *  existing ChatSession__c.ActiveTopic__c persistence needs no change). */
  activeTopicName?: string | null;
  /** Set by the ADAPTER when the model's tool-selection picked a handoff
   *  tool (see subagent-router.ts) instead of answering directly or using a
   *  plain tool. When set, this call's assistantText/toolCalls are NOT the
   *  turn's real output — chat-engine.ts discards them and makes a second
   *  call as the named subagent's own turn. Only tokensIn/tokensOut from
   *  THIS call still count (summed with the subagent's own usage). */
  handoffSubagentNodeId?: string | null;
  /** Only populated when ChatTurnRequest.debugMode is true. One entry per
   *  provider call this turn (a narration-only continuation adds a second
   *  round) — Apex stores these verbatim on the assistant ChatMessage__c. */
  debugRequest?: unknown[];
  debugResponse?: unknown[];
}

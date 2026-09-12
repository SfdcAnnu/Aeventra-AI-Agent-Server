/**
 * replay-verify — offline checks for tool-result replay + the session cache.
 *
 * These paths only misbehave inside a live conversation (the symptom is an
 * agent re-running queries it already answered), and a live run costs real
 * model tokens. Everything here is exercised with synthetic history and a
 * fake tool, so it can be run as often as needed for free.
 *
 *   npx tsx scripts/replay-verify.ts
 */
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { toLangchainMessages } from '../src/lc/graph-runtime';
import { budgetToolReplays, decodeStoredResult, parseToolRow } from '../src/chat/tool-replay';
import { withSessionResultCache, invalidateSession } from '../src/lc/tool-result-cache';
import { createTurnBudget, noteUsage, noteToolCall, usageByModel } from '../src/lc/turn-budget';
import { buildChatModel, modelOptionsFromConfig } from '../src/lc/models';
import type { ChatHistoryMessage } from '../src/chat/adapters/types';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Apex persists Content__c as JSON.serialize(<string>).
const stored = (s: string) => JSON.stringify(s);

const OPP_QUERY = "SELECT Id, Name, StageName, Amount, Loss_Reason__c FROM Opportunity WHERE Id = '006g5000006ric9AAA' LIMIT 1";
const OPP_RESULT = '{"records":[{"Id":"006g5000006ric9AAA","StageName":"Closed Lost","Amount":65000,"Loss_Reason__c":"Price"}],"totalSize":1}';

function toolRow(name: string, args: object, result: string, id: string | null): ChatHistoryMessage {
  return {
    role: 'tool',
    content: stored(result),
    toolCallsJson: JSON.stringify({ id, name, args }),
    toolResultsJson: null,
  };
}

// ── 1. Decoding ──────────────────────────────────────────────────────
console.log('\n1. Stored results decode out of their JSON envelope');
check('double-encoded result unwraps', decodeStoredResult(stored(OPP_RESULT)) === OPP_RESULT);
check('plain result passes through', decodeStoredResult(OPP_RESULT) === OPP_RESULT);
check('malformed input never throws', decodeStoredResult('"{unclosed') === '"{unclosed');

// ── 2. Budgeting ─────────────────────────────────────────────────────
console.log('\n2. Recency budget replaces the flat 600-char clip');
const bigSchema = '{"mode":"detail","name":"Opportunity","fields":[' + 'x'.repeat(9000) + ']}';
const budgetedRecent = budgetToolReplays([bigSchema]);
check('a recent large result keeps far more than 600 chars',
  budgetedRecent[0].length > 2_500, `got ${budgetedRecent[0].length}`);

const many = Array.from({ length: 14 }, () => bigSchema);
const budgetedMany = budgetToolReplays(many);
check('older results shrink below recent ones',
  budgetedMany[0].length < budgetedMany[many.length - 1].length,
  `oldest ${budgetedMany[0].length} vs newest ${budgetedMany[many.length - 1].length}`);
check('total replay stays under the global cap',
  budgetedMany.reduce((n, s) => n + s.length, 0) < 30_000,
  `total ${budgetedMany.reduce((n, s) => n + s.length, 0)}`);

const artifactRef = JSON.stringify({
  artifact: 'art_27b6b232dc',
  note: 'Large result stored by reference — use read_artifact to fetch further sections.',
  totalChars: 10288,
  preview: 'y'.repeat(500),
});
const withArtifact = budgetToolReplays([...Array.from({ length: 20 }, () => bigSchema), artifactRef]);
check('artifact handle survives intact even far down a long history',
  withArtifact[20].includes('art_27b6b232dc'));
const oldArtifact = budgetToolReplays([artifactRef, ...Array.from({ length: 20 }, () => bigSchema)]);
check('artifact handle survives even as the OLDEST entry',
  oldArtifact[0].includes('art_27b6b232dc'));

// ── 3. Real tool pairs ───────────────────────────────────────────────
console.log('\n3. History with call ids replays as real tool-call/result pairs');
const withIds: ChatHistoryMessage[] = [
  { role: 'user', content: 'Hello' },
  toolRow('soqlQuery', { query: OPP_QUERY }, OPP_RESULT, 'call_a1'),
  toolRow('getObjectSchema', { name: 'Opportunity' }, artifactRef, 'call_a2'),
  { role: 'assistant', content: 'Following up on your quote.' },
  { role: 'user', content: "It's too high" },
];
const paired = toLangchainMessages(withIds, 'and my budget is 48k', []);
const aiWithCalls = paired.filter(m => m instanceof AIMessage && (m.tool_calls?.length ?? 0) > 0) as AIMessage[];
const toolMsgs = paired.filter(m => m instanceof ToolMessage) as ToolMessage[];
check('an assistant message carries the tool calls', aiWithCalls.length === 1,
  `got ${aiWithCalls.length}`);
check('both calls are on it', (aiWithCalls[0]?.tool_calls?.length ?? 0) === 2);
check('each call has a matching ToolMessage', toolMsgs.length === 2);
check('ids pair up exactly',
  toolMsgs.every(t => aiWithCalls[0].tool_calls!.some(c => c.id === t.tool_call_id)));
check('arguments survive the round trip',
  (aiWithCalls[0]?.tool_calls?.[0]?.args as { query?: string })?.query === OPP_QUERY);
check('result content is decoded, not escaped',
  toolMsgs[0].content === OPP_RESULT, String(toolMsgs[0].content).slice(0, 80));
check('the final user message is last', paired[paired.length - 1] instanceof HumanMessage);
check('no orphaned tool_call_id',
  toolMsgs.every(t => !!t.tool_call_id));

// ── 4. Backward compatibility ────────────────────────────────────────
console.log('\n4. Pre-fix rows (null id) still replay, as prose');
const noIds: ChatHistoryMessage[] = [
  { role: 'user', content: 'Hello' },
  toolRow('soqlQuery', { query: OPP_QUERY }, OPP_RESULT, null),
  { role: 'assistant', content: 'Following up.' },
];
const legacy = toLangchainMessages(noIds, 'next', []);
check('no tool messages emitted without ids',
  legacy.every(m => !(m instanceof ToolMessage)));
check('the result is still present in context',
  legacy.some(m => typeof m.content === 'string' && m.content.includes('Closed Lost')));
check('and it is decoded there too',
  legacy.some(m => typeof m.content === 'string' && m.content.includes('"StageName":"Closed Lost"')));

// ── 5. Mid-run history slices ────────────────────────────────────────
console.log('\n5. A slice starting mid-tool-run never opens with an assistant turn');
const slicedMidRun: ChatHistoryMessage[] = [
  toolRow('soqlQuery', { query: OPP_QUERY }, OPP_RESULT, 'call_b1'),
  toolRow('soqlQuery', { query: OPP_QUERY }, OPP_RESULT, 'call_b2'),
  { role: 'assistant', content: 'Here is what I found.' },
];
const sliced = toLangchainMessages(slicedMidRun, 'ok', []);
check('first message is a human turn (Anthropic requires it)',
  sliced[0] instanceof HumanMessage, sliced[0]?.constructor.name);
check('the earlier results are still carried',
  typeof sliced[0].content === 'string' && sliced[0].content.includes('Closed Lost'));

// ── 6. Session result cache ──────────────────────────────────────────
// Wrapped: this project compiles to CommonJS, which has no top-level await.
async function main(): Promise<void> {
console.log('\n6. Session cache: identical reads run once, writes invalidate');
let reads = 0;
let writes = 0;
const readTool = tool(async (_a: { query: string }) => { reads++; return OPP_RESULT; },
  { name: 'soqlQuery', description: 'read', schema: z.object({ query: z.string() }) }) as StructuredToolInterface;
const writeTool = tool(async (_a: { body: string }) => { writes++; return '{"id":"006x"}'; },
  { name: 'updateSobjectRecord', description: 'write', schema: z.object({ body: z.string() }) }) as StructuredToolInterface;
const failTool = tool(async () => 'Error: MCP tool failed', // non-answers must stay repeatable
  { name: 'getObjectSchema', description: 'read', schema: z.object({}) }) as StructuredToolInterface;

const [cachedRead, cachedWrite, cachedFail] =
  withSessionResultCache([readTool, writeTool, failTool], 'session-A');

await cachedRead.invoke({ query: OPP_QUERY } as never);
await cachedRead.invoke({ query: OPP_QUERY } as never);
check('the identical repeat is served from cache', reads === 1, `executed ${reads}x`);

await cachedRead.invoke({ query: 'SELECT Id FROM Contact' } as never);
check('a different query still executes', reads === 2, `executed ${reads}x`);

// Argument key order must not matter — models do not emit stable key order.
let orderReads = 0;
const twoArg = tool(async (_a: { a: string; b: string }) => { orderReads++; return 'ok'; },
  { name: 'find', description: 'read', schema: z.object({ a: z.string(), b: z.string() }) }) as StructuredToolInterface;
const [cachedTwoArg] = withSessionResultCache([twoArg], 'session-A');
await cachedTwoArg.invoke({ a: '1', b: '2' } as never);
await cachedTwoArg.invoke({ b: '2', a: '1' } as never);
check('key order does not change the cache key', orderReads === 1, `executed ${orderReads}x`);

await cachedFail.invoke({} as never);
await cachedFail.invoke({} as never);
check('errors are never cached',
  (await cachedFail.invoke({} as never)) === 'Error: MCP tool failed');

await cachedWrite.invoke({ body: '{}' } as never);
check('the write executed', writes === 1);
await cachedRead.invoke({ query: OPP_QUERY } as never);
check('the write invalidated the cached read', reads === 3, `executed ${reads}x`);

// Isolation between sessions.
const [otherRead] = withSessionResultCache([readTool], 'session-B');
await otherRead.invoke({ query: OPP_QUERY } as never);
check('another session does not share cached results', reads === 4, `executed ${reads}x`);

const [uncached] = withSessionResultCache([readTool], null);
await uncached.invoke({ query: OPP_QUERY } as never);
await uncached.invoke({ query: OPP_QUERY } as never);
check('no session id means no caching at all', reads === 6, `executed ${reads}x`);

invalidateSession('session-A');
invalidateSession('session-B');

// ── 7. The CHAT-0149 regression, end to end ──────────────────────────
console.log('\n7. Regression: the schema that caused the re-read cascade');
const schemaArtifact = JSON.stringify({
  artifact: 'art_27b6b232dc',
  note: 'Large result stored by reference — use read_artifact to fetch further sections.',
  totalChars: 10288,
  preview: '{"mode":"detail","name":"Opportunity"',
});
const fullSchema = JSON.stringify({
  mode: 'detail', name: 'Opportunity',
  fields: Array.from({ length: 60 }, (_, i) => ({ name: i === 59 ? 'Loss_Reason__c' : `Field${i}__c`, type: 'string' })),
});
const chat149: ChatHistoryMessage[] = [
  { role: 'user', content: 'Hello' },
  toolRow('getObjectSchema', { name: 'Opportunity' }, schemaArtifact, 'call_c1'),
  toolRow('read_artifact', { artifact_id: 'art_27b6b232dc' }, fullSchema, 'call_c2'),
  { role: 'assistant', content: 'Following up on your GenWatt quote.' },
];
const replayed = toLangchainMessages(chat149, "It's too high", []);
const replayedText = replayed.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
check('the artifact handle is still available to read_artifact',
  replayedText.includes('art_27b6b232dc'));
check('Loss_Reason__c survives replay (the field it re-read the schema for)',
  replayedText.includes('Loss_Reason__c'));
check('full schema is NOT clipped to 600 chars',
  (replayed.find(m => m instanceof ToolMessage && m.tool_call_id === 'call_c2')?.content as string)?.length > 2_000);

// ── 8. Per-model usage accounting ────────────────────────────────────
console.log('\n8. Usage is attributed per model, not to whoever answered last');
const budget = createTurnBudget({});
const aiMsg = (inTok: number, outTok: number, cacheRead?: number) =>
  new AIMessage({
    content: '',
    usage_metadata: {
      input_tokens: inTok,
      output_tokens: outTok,
      total_tokens: inTok + outTok,
      ...(cacheRead ? { input_token_details: { cache_read: cacheRead } } : {}),
    } as never,
  });

// A realistic multi-model turn: the router answers on one model, hands off
// to a specialist on another, then a guardrail pass re-runs on the router's.
noteUsage(budget, aiMsg(1000, 120, 400), 'router', 'gpt-5.5');
noteUsage(budget, aiMsg(300, 40), 'subagent', 'claude-haiku-4-5');
noteUsage(budget, aiMsg(200, 30), 'guardrail_regen', 'gpt-5.5');

const rows = usageByModel(budget);
const gpt = rows.find(r => r.model === 'gpt-5.5');
const haiku = rows.find(r => r.model === 'claude-haiku-4-5');
check('each model gets its own row', rows.length === 2, `got ${rows.length}`);
check('the router model accumulates across its stages',
  gpt?.tokensIn === 1200 && gpt?.tokensOut === 150 && gpt?.calls === 2,
  JSON.stringify(gpt));
check('the specialist is not folded into the router',
  haiku?.tokensIn === 300 && haiku?.tokensOut === 40, JSON.stringify(haiku));
check('stages are recorded per model',
  gpt?.stages.join(',') === 'router,guardrail_regen', gpt?.stages.join(','));
check('cache reads are broken out', gpt?.cacheRead === 400, String(gpt?.cacheRead));
check('per-model tokens sum back to the turn totals',
  rows.reduce((n, r) => n + r.tokensIn, 0) === budget.tokensIn &&
  rows.reduce((n, r) => n + r.tokensOut, 0) === budget.tokensOut,
  `${budget.tokensIn}/${budget.tokensOut}`);
check('rows are ordered by heaviest model first', rows[0].model === 'gpt-5.5');

// Tokens spent with no model name must still be counted.
const anon = createTurnBudget({});
noteUsage(anon, aiMsg(50, 5), 'router', undefined);
const anonRows = usageByModel(anon);
check('a missing model name is bucketed, never dropped',
  anonRows.length === 1 && anonRows[0].model === 'unknown' && anonRows[0].tokensIn === 50,
  JSON.stringify(anonRows));

// Tool calls share the event stream but are not model usage.
const mixed = createTurnBudget({});
noteUsage(mixed, aiMsg(10, 2), 'router', 'gpt-5.5');
noteToolCall(mixed, 'soqlQuery', { q: 1 }, 'tools');
check('tool-call events are excluded from model usage',
  usageByModel(mixed).length === 1 && usageByModel(mixed)[0].calls === 1);

// ── 9. The inspector knobs actually reach the provider ───────────────
console.log('\n9. Answer style / Thinking effort / Longest reply are live');
const balanced = modelOptionsFromConfig({ answerStyle: 'balanced', thinkingEffort: 'standard' });
check('balanced + standard changes nothing (existing agents keep behaving)',
  balanced.options.temperature === undefined &&
  balanced.options.reasoningEffort === undefined &&
  balanced.maxTokens === undefined,
  JSON.stringify(balanced));

const precise = modelOptionsFromConfig({ answerStyle: 'precise' });
const exploratory = modelOptionsFromConfig({ answerStyle: 'exploratory' });
check('precise lowers temperature', (precise.options.temperature ?? 1) < 0.5);
check('exploratory raises it', (exploratory.options.temperature ?? 0) > 0.5);

check('thinking off asks for minimal reasoning',
  modelOptionsFromConfig({ thinkingEffort: 'off' }).options.reasoningEffort === 'minimal');
check('thinking deep asks for high reasoning',
  modelOptionsFromConfig({ thinkingEffort: 'deep' }).options.reasoningEffort === 'high');

check('a reply cap is passed through',
  modelOptionsFromConfig({ maxReplyTokens: 2048 }).maxTokens === 2048);
check('a nonsense cap is ignored rather than capping at zero',
  modelOptionsFromConfig({ maxReplyTokens: 0 }).maxTokens === undefined &&
  modelOptionsFromConfig({ maxReplyTokens: 'lots' }).maxTokens === undefined);
check('an empty config is safe', modelOptionsFromConfig(undefined).maxTokens === undefined);

// The node's model must win over the connection's default: the reverse
// made the canvas picker decorative.
const nodeWins = buildChatModel('gpt4', 'gpt-5.5-pro',
  { engineType: 'openai', apiKey: 'sk-test', defaultModel: 'gpt-5.5' } as never);
check('the node\'s model beats the connection default',
  nodeWins.modelName === 'gpt-5.5-pro', nodeWins.modelName);
const connFallback = buildChatModel('gpt4', undefined,
  { engineType: 'openai', apiKey: 'sk-test', defaultModel: 'gpt-5.5' } as never);
check('the connection default still applies when the node picked nothing',
  connFallback.modelName === 'gpt-5.5', connFallback.modelName);

// Reasoning-era OpenAI models reject an explicit temperature outright.
const reasoning = buildChatModel('gpt4', 'gpt-5.5',
  { engineType: 'openai', apiKey: 'sk-test' } as never, 4000, { temperature: 0.2 });
check('no temperature is sent to a reasoning-era model',
  (reasoning.model as unknown as { temperature?: number }).temperature !== 0.2);
const classic = buildChatModel('gpt4', 'gpt-4o',
  { engineType: 'openai', apiKey: 'sk-test' } as never, 4000, { temperature: 0.2 });
check('but it is sent to a classic one',
  (classic.model as unknown as { temperature?: number }).temperature === 0.2);

// ── 10. Responses-only models ────────────────────────────────────────
console.log('\n10. -pro models go to the Responses API, not chat completions');
const proModel = buildChatModel('gpt4', 'gpt-5.5-pro',
  { engineType: 'openai', apiKey: 'sk-test' } as never, 4000, { reasoningEffort: 'high' });
const proRaw = proModel.model as unknown as { useResponsesApi?: boolean; maxTokens?: number; reasoningEffort?: string };
check('gpt-5.5-pro uses the Responses API', proRaw.useResponsesApi === true, String(proRaw.useResponsesApi));
check('it keeps reasoning headroom on top of the cap', (proRaw.maxTokens ?? 0) > 4000, String(proRaw.maxTokens));
check('reasoning effort is passed as a typed option', proRaw.reasoningEffort === 'high');

for (const name of ['gpt-5-pro', 'o3-pro', 'o1-pro']) {
  const m = buildChatModel('gpt4', name, { engineType: 'openai', apiKey: 'sk-test' } as never);
  check(`${name} routes to the Responses API`,
    (m.model as unknown as { useResponsesApi?: boolean }).useResponsesApi === true);
}
for (const name of ['gpt-5.5', 'gpt-4o', 'gpt-4.1-mini']) {
  const m = buildChatModel('gpt4', name, { engineType: 'openai', apiKey: 'sk-test' } as never);
  check(`${name} stays on chat completions`,
    (m.model as unknown as { useResponsesApi?: boolean }).useResponsesApi !== true);
}

console.log(failures === 0 ? '\nAll replay checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
}

void main();

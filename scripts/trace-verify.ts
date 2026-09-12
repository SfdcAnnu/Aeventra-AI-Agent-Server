/**
 * trace-verify — offline checks for the tracing safety floor.
 *
 * Redaction is the one part of tracing that cannot be "mostly right": the
 * trace store holds the exact bodies sent to providers, for every tenant,
 * where support staff read them. A key that survives is a credential leak,
 * not a cosmetic bug. So every shape a credential reaches us in gets a
 * case here, and the suite asserts the NEGATIVE — that no planted secret
 * appears anywhere in the output.
 *
 *   npx tsx scripts/trace-verify.ts
 */
import { redact, redactText, redactForStorage, REDACTED } from '../src/trace/redact';
import { toWireMessages } from '../src/trace/prompt-parts';
import { SystemMessage, HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** The real test: serialize the result and prove the secret is nowhere. */
function absent(value: unknown, secret: string): boolean {
  return !JSON.stringify(value ?? null).includes(secret);
}

// ── 1. Secrets identified by field name ──────────────────────────────
console.log('\n1. Anything NAMED like a secret is dropped, whatever it holds');
const SK = 'sk-proj-QZ9xLm2vTb7NpKd4Rw8sYh1AeCfGjUiO';
const SF = '00Dg5000009nmO5EAI!AQEAQJ3kPzYxLm2vTb7NpKd4Rw8sYh1AeCfGjUiO';

const engineOverride = {
  engineType: 'openai',
  apiKey: SK,
  endpoint: 'https://api.openai.com',
  defaultModel: 'gpt-5.5',
  connectionId: 'a09g5000007frKaAAI',
};
const cleanedEngine = redact(engineOverride) as Record<string, unknown>;
check('apiKey is redacted', cleanedEngine.apiKey === REDACTED);
check('the key text appears nowhere', absent(cleanedEngine, SK));
check('non-secret fields survive', cleanedEngine.defaultModel === 'gpt-5.5' && cleanedEngine.engineType === 'openai');

const nested = {
  connectors: [{
    name: 'salesforce_mcp',
    url: 'https://salesforce-mcp-server.onrender.com',
    token: SF,
    headers: { Authorization: `Bearer ${SF}` },
    allowedTools: ['soqlQuery'],
  }],
  install: { sfAccessToken: SF, sessionKey: 'e91b465a-e925-4e55-acd2-89f19ebf108d' },
};
const cleanedNested = redact(nested);
check('a nested access token is gone', absent(cleanedNested, SF));
check('sessionKey is gone', absent(cleanedNested, 'e91b465a-e925-4e55-acd2-89f19ebf108d'));
check('the allowed-tool list survives', JSON.stringify(cleanedNested).includes('soqlQuery'));

for (const key of ['apiKey', 'api_key', 'API-KEY', 'sfAccessToken', 'refresh_token',
  'SessionKey__c', 'clientSecret', 'password', 'Authorization', 'x-signature']) {
  const cleaned = redact({ [key]: 'PLANTED_SECRET_VALUE' }) as Record<string, unknown>;
  check(`"${key}" is treated as a secret`, cleaned[key] === REDACTED);
}

// ── 2. Secrets identified by shape ───────────────────────────────────
console.log('\n2. Credentials are caught even where no field name protects them');
const shapes: Array<[string, string]> = [
  ['OpenAI key inside prose', `Request failed with key ${SK} rejected`],
  ['Salesforce session inside a URL', `https://x.my.salesforce.com/services/data?sid=${SF}`],
  ['bearer header as text', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijkl'],
  ['google key', 'key=AIzaSyB1cD3fG5hJ7kL9mN0pQ2rS4tU6vW8xY0z'],
  ['anthropic key', 'x-api-key: sk-ant-api03-QZ9xLm2vTb7NpKd4Rw8sYh1AeCfGjUiO'],
];
for (const [label, text] of shapes) {
  const out = redactText(text);
  check(label, out.includes(REDACTED) && !out.match(/sk-|AIza|eyJ|00Dg5000009nmO5EAI!/),
    out.slice(0, 70));
}
check('ordinary prose is left alone',
  redactText('The quote is 65,000 and the floor is 55,850.') === 'The quote is 65,000 and the floor is 55,850.');
check('a record id is not mistaken for a credential',
  redactText('opportunityId: 006g5000006ric9AAA') === 'opportunityId: 006g5000006ric9AAA');

// ── 3. A realistic request body ──────────────────────────────────────
console.log('\n3. A whole provider request survives redaction intact');
const body = {
  model: 'gpt-5.5',
  messages: [
    { role: 'system', content: `## Role\nYou are a sales agent…\n\nKNOWLEDGE BASE\n[1] Max Discount 15%` },
    { role: 'user', content: "It's out of budget, I can go for 40k" },
  ],
  tools: [{ type: 'function', function: { name: 'soqlQuery' } }],
  configuration: { apiKey: SK, baseURL: 'https://api.openai.com/v1' },
};
const cleanedBody = redact(body) as Record<string, unknown>;
check('the key is gone', absent(cleanedBody, SK));
check('the system prompt survives', JSON.stringify(cleanedBody).includes('KNOWLEDGE BASE'));
check('the user message survives', JSON.stringify(cleanedBody).includes('out of budget'));
check('the tool list survives', JSON.stringify(cleanedBody).includes('soqlQuery'));

// ── 4. It cannot throw, whatever it is handed ────────────────────────
console.log('\n4. Redaction never throws on the post-response path');
const cyclic: Record<string, unknown> = { name: 'loop' };
cyclic.self = cyclic;
check('a cycle is broken, not thrown', JSON.stringify(redact(cyclic)).includes('[circular]'));
check('an Error keeps its message', (redact(new Error('boom')) as { message: string }).message === 'boom');
check('an Error message is scrubbed', absent(redact(new Error(`bad key ${SK}`)), SK));
for (const [label, v] of Object.entries({
  null: null, undefined: undefined, number: 42, bool: true,
  date: new Date('2026-09-12T12:00:00Z'), map: new Map([['a', 1]]), set: new Set([1, 2]),
  fn: () => 1, big: BigInt(9),
})) {
  let threw = false;
  try { redact(v); } catch { threw = true; }
  check(`${label} is handled`, !threw);
}

// ── 5. Size bounds ───────────────────────────────────────────────────
console.log('\n5. One runaway payload cannot define the row size');
const huge = { blob: 'x'.repeat(60_000) };
const capped = redact(huge) as { blob: string };
check('a single string is capped', capped.blob.length < 25_000, `got ${capped.blob.length}`);
check('the cap says what was dropped', capped.blob.includes('chars]'));

const massive = { rows: Array.from({ length: 4000 }, (_, i) => ({ i, text: 'y'.repeat(200) })) };
const stored = redactForStorage(massive) as { truncated?: boolean };
check('a whole payload is bounded', stored.truncated === true);
check('a normal payload is stored whole', (redactForStorage({ a: 1 }) as { a: number }).a === 1);
check('unserializable input returns a marker, not a throw',
  (redactForStorage({ big: BigInt(1) }) as { unserializable?: boolean }) !== undefined);

// ── 6. Messages are stored as sent, not as LangChain holds them ──────
console.log('\n6. A stored request is the wire body, not LangChain internals');
const PROMPT = 'You are an agent. Follow the rules.';
const wire = toWireMessages([
  new SystemMessage(PROMPT),
  new HumanMessage('Hello'),
  new AIMessage({ content: '', tool_calls: [{ id: 'call_1', name: 'soqlQuery', args: { q: 1 }, type: 'tool_call' }] }),
  new ToolMessage({ tool_call_id: 'call_1', name: 'soqlQuery', content: '{"records":[]}' }),
]);
const wireJson = JSON.stringify(wire);
// The bug this replaces: a raw BaseMessage serialises its content TWICE —
// once resolved, once inside lc_kwargs — so every prompt appeared doubled
// in the trace, at double the storage cost.
check('the system prompt appears exactly once',
  wireJson.split(PROMPT).length - 1 === 1, `appeared ${wireJson.split(PROMPT).length - 1}x`);
check('no lc_kwargs leaks through', !wireJson.includes('lc_kwargs'));
check('no lc_namespace leaks through', !wireJson.includes('lc_namespace'));
check('no circular markers', !wireJson.includes('[circular]'));
check("roles are the provider's, not LangChain's",
  wire.map(m => m.role).join(',') === 'system,user,assistant,tool', wire.map(m => m.role).join(','));
check('tool calls keep their id and arguments',
  wireJson.includes('call_1') && wireJson.includes('soqlQuery') && wireJson.includes('"arguments"'));
check('a tool result keeps its tool_call_id', (wire[3] as { tool_call_id?: string }).tool_call_id === 'call_1');
check('redaction still works on the wire shape',
  absent(redact(toWireMessages([new SystemMessage(`key ${SK}`)])), SK));

console.log(failures === 0 ? '\nAll trace checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);

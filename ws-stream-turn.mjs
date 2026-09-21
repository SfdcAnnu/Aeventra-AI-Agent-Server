// One chat turn with narration switched on, exactly as the browser now
// sends it. Prints every frame with the second it arrived, so the proof is
// visible: stage frames must land DURING the turn, not batched at the end,
// and the reply must still arrive intact and unchanged in shape.
import { readFileSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const [authPath, agentApiName, sessionId, message, outPath] = process.argv.slice(2);
const auth = JSON.parse(readFileSync(authPath, 'utf8'));
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);

let ticket, wsUrl;
if (auth.ticket && auth.wsUrl) { ({ ticket, wsUrl } = auth); }
else {
  const res = await fetch(`${auth.instanceUrl}/services/apexrest/agent-builder/ws-ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentApiName, sessionId }),
  });
  if (!res.ok) { console.log('ticket http', res.status, (await res.text()).slice(0, 300)); process.exit(1); }
  ({ ticket, wsUrl } = await res.json());
}

const origin = process.env.WS_ORIGIN || auth.origin || 'https://orgfarm-ac9142a7a9-dev-ed.develop.my.salesforce.com';
const ws = new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(ticket)}`, { headers: { Origin: origin } });

let stages = 0;
let firstStageAt = null;
let openedAt = 0;
let deltas = 0, firstDeltaAt = null, lastDeltaAt = null, streamed = '', resets = 0;

ws.on('open', () => {
  openedAt = Date.now();
  console.log(`[${at()}s] socket open; sending with stream:true`);
  ws.send(JSON.stringify({ newUserMessage: message, history: [], stream: true }));
});

ws.on('message', data => {
  const f = JSON.parse(String(data));

  if (f.type === 'stage') {
    stages += 1;
    if (firstStageAt === null) firstStageAt = Date.now();
    const via = f.via ? `${f.via} · ` : '';
    const tail = f.state === 'end' ? ` (${f.ms}ms${f.isError ? ', refused' : ''})` : '';
    console.log(`[${at()}s] stage #${f.seq} ${f.state.padEnd(5)} ${via}${f.name}${tail}`);
    return;
  }

  if (f.type === 'text.delta') {
    deltas += 1;
    if (firstDeltaAt === null) { firstDeltaAt = Date.now(); console.log(`[${at()}s] first text delta`); }
    lastDeltaAt = Date.now();
    streamed += f.delta;
    return;
  }
  if (f.type === 'text.reset') { resets += 1; streamed = ''; console.log(`[${at()}s] text.reset`); return; }

  console.log(`[${at()}s] TURN ${f.status} tokens ${f.tokensIn ?? '?'}/${f.tokensOut ?? '?'} model=${f.modelUsed ?? ''}`);
  if (f.error || f.message) console.log('  error:', f.error, f.message);
  console.log('  reply:', (f.assistantText ?? '').slice(0, 400).replace(/\n+/g, ' '));
  console.log('  toolCalls in result:', (f.toolCalls ?? []).length);
  console.log('');
  console.log('--- verdict ---');
  console.log('stage frames received :', stages);
  console.log('first stage arrived at:', firstStageAt ? `${((firstStageAt - openedAt) / 1000).toFixed(1)}s after open` : 'never');
  console.log('reply arrived at      :', `${((Date.now() - openedAt) / 1000).toFixed(1)}s after open`);
  console.log('narration was live    :', firstStageAt && Date.now() - firstStageAt > 250 ? 'YES — frames spread across the turn' : 'inconclusive');
  console.log('tokens counted        :', (f.tokensIn ?? 0) > 0 && (f.tokensOut ?? 0) > 0 ? 'YES' : 'NO — investigate');
  console.log('text deltas           :', deltas, resets ? `(${resets} reset)` : '');
  console.log('first delta at        :', firstDeltaAt ? `${((firstDeltaAt - openedAt) / 1000).toFixed(1)}s after open` : 'never');
  console.log('streaming spanned     :', firstDeltaAt && lastDeltaAt ? `${((lastDeltaAt - firstDeltaAt) / 1000).toFixed(1)}s` : 'n/a');
  console.log('head start over reply :', firstDeltaAt ? `${((Date.now() - firstDeltaAt) / 1000).toFixed(1)}s before the final frame` : 'none');
  const finalText = (f.assistantText ?? '').trim();
  console.log('streamed vs final     :', streamed.trim() === finalText ? 'IDENTICAL' : `differs (streamed ${streamed.trim().length}, final ${finalText.length})`);
  if (outPath) writeFileSync(outPath, JSON.stringify(f, null, 2));
  ws.close();
});

ws.on('error', e => { console.log('socket error', e.message); process.exit(1); });
ws.on('close', () => process.exit(0));
setTimeout(() => { console.log('gave up after 560s'); process.exit(2); }, 560_000);

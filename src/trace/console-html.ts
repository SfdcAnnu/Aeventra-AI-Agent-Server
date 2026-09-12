/**
 * console-html — the operator console, served as one self-contained page.
 *
 * No build step and no deployment of its own: the server already runs, so
 * the debugging surface ships with it. It reads the same admin API a curl
 * would, carrying the key it was opened with, and renders a composed view
 * of each request so a 15,000-token prompt is legible instead of one
 * escaped string.
 */
export function renderConsole(): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Flight Recorder</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<style>
:root{--ground:#10151c;--surface:#171e27;--raised:#1d2631;--sunken:#0d1219;--rule:#232c38;
--ink:#dde5ef;--ink-dim:#8593a5;--ink-faint:#5d6b7d;--accent:#4ea3d8;--accent-soft:#1b3648;
--ok:#4ba97a;--warn:#d9a441;--crit:#d96a6a;--violet:#9d8ad4;
--ok-bg:#14291f;--warn-bg:#2e2515;--crit-bg:#2e1a1a;--violet-bg:#241f33}
@media(prefers-color-scheme:light){:root:not([data-theme="dark"]){
--ground:#eef1f5;--surface:#fff;--raised:#f5f7fa;--sunken:#f8fafc;--rule:#d9dfe7;
--ink:#1a222c;--ink-dim:#5b6878;--ink-faint:#8b97a6;--accent:#1d6f9e;--accent-soft:#dceaf4;
--ok:#1f7a4d;--warn:#8a6212;--crit:#a33a3a;--violet:#5b4a91;
--ok-bg:#e4f2ea;--warn-bg:#f6eeda;--crit-bg:#f8e6e6;--violet-bg:#ece8f6}}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:400 14px/1.5 "IBM Plex Sans",ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.mono{font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace}.num{font-variant-numeric:tabular-nums}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
.wrap{max-width:1440px;margin:0 auto;padding:22px 20px 64px}
.masthead{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
.masthead h1{margin:0;font-size:19px;font-weight:700;letter-spacing:-.015em}
.eyebrow{font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);padding:3px 7px;background:var(--accent-soft);border-radius:3px}
.sub{margin:6px 0 18px;color:var(--ink-dim);font-size:13px;max-width:68ch}
.filters{display:grid;gap:8px;padding:12px;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));background:var(--surface);border:1px solid var(--rule);border-radius:8px}
.field{display:flex;flex-direction:column;gap:4px;min-width:0}
.field label{font-size:9.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint)}
.field input,.field select{font:500 12px/1 "IBM Plex Mono",monospace;background:var(--raised);color:var(--ink);border:1px solid var(--rule);border-radius:5px;padding:7px 8px;min-width:0}
.stats{display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin:12px 0}
.stat{background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:11px 13px}
.stat .k{font-size:9.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint)}
.stat .v{font-size:21px;font-weight:600;margin-top:3px;letter-spacing:-.02em}
.stat .d{font-size:11px;color:var(--ink-dim);margin-top:1px}.stat.alert .v{color:var(--crit)}
.panes{display:grid;gap:12px;grid-template-columns:minmax(0,400px) minmax(0,1fr);align-items:start}
@media(max-width:1040px){.panes{grid-template-columns:minmax(0,1fr)}}
.panel{background:var(--surface);border:1px solid var(--rule);border-radius:8px;overflow:hidden}
.panel>header{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 13px;border-bottom:1px solid var(--rule);background:var(--raised)}
.panel>header h2{margin:0;font-size:12.5px;font-weight:600}
.panel>header .note{font-size:11px;color:var(--ink-dim);margin-left:auto}
.rows{max-height:620px;overflow-y:auto}
.row{display:grid;grid-template-columns:3px 1fr auto;gap:0 10px;align-items:center;width:100%;text-align:left;padding:9px 13px 9px 0;background:none;border:0;border-bottom:1px solid var(--rule);color:inherit;cursor:pointer;font:inherit}
.row:hover{background:var(--raised)}.row[aria-current="true"]{background:var(--accent-soft)}
.row .stripe{align-self:stretch;border-radius:0 2px 2px 0}.row .who{min-width:0}
.row .line1{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.row .agent{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:20ch}
.row .line2{font-size:10.5px;color:var(--ink-dim);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .right{text-align:right;font-size:11px}.row .lat{font-weight:600}.row .tok{color:var(--ink-dim)}
.pill{font-size:9.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;padding:2px 6px;border-radius:3px;white-space:nowrap}
.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.warn{background:var(--warn-bg);color:var(--warn)}
.pill.crit{background:var(--crit-bg);color:var(--crit)}
.pill.plain{background:var(--raised);color:var(--ink-dim);border:1px solid var(--rule)}
.meta{display:grid;gap:1px;background:var(--rule);border-bottom:1px solid var(--rule);grid-template-columns:repeat(auto-fit,minmax(158px,1fr))}
.meta div{background:var(--surface);padding:9px 13px}
.meta .k{font-size:9.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint)}
.meta .v{font-size:12px;margin-top:2px;word-break:break-all}
.step{border-bottom:1px solid var(--rule)}.step:last-child{border-bottom:0}
.step>summary{display:grid;grid-template-columns:26px 1fr auto;gap:10px;align-items:center;padding:9px 13px;cursor:pointer;list-style:none}
.step>summary::-webkit-details-marker{display:none}.step>summary:hover{background:var(--raised)}
.seq{font-size:10px;font-weight:600;text-align:center;padding:3px 0;border-radius:3px;background:var(--raised);color:var(--ink-dim);border:1px solid var(--rule)}
.step .title{font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.step .subtitle{font-size:10.5px;color:var(--ink-dim);margin-top:2px}
.step .timing{font-size:11px;text-align:right;color:var(--ink-dim)}.step .timing b{color:var(--ink);font-weight:600}
.bar{height:4px;border-radius:2px;background:var(--rule);overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}
.payloads{display:grid;gap:10px;padding:2px 13px 14px;grid-template-columns:repeat(auto-fit,minmax(330px,1fr))}
.payload{border:1px solid var(--rule);border-radius:6px;overflow:hidden;background:var(--sunken)}
.payload>h4{margin:0;padding:6px 9px;font-size:9.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint);border-bottom:1px solid var(--rule);display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--raised)}
.payload pre{margin:0;padding:9px;max-height:340px;overflow:auto;font:400 11px/1.55 "IBM Plex Mono",monospace;white-space:pre-wrap;word-break:break-word;color:var(--ink)}
.seg{display:inline-flex;border:1px solid var(--rule);border-radius:4px;overflow:hidden}
.seg button{font:600 9.5px/1 "IBM Plex Sans",sans-serif;letter-spacing:.06em;text-transform:uppercase;padding:4px 7px;background:var(--surface);color:var(--ink-dim);border:0;cursor:pointer}
.seg button[aria-pressed="true"]{background:var(--accent);color:#fff}
.parts{padding:7px;display:grid;gap:5px;max-height:470px;overflow-y:auto}
.part{border:1px solid var(--rule);border-radius:5px;background:var(--surface);overflow:hidden}
.part>summary{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;padding:7px 9px;cursor:pointer;list-style:none}
.part>summary::-webkit-details-marker{display:none}.part>summary:hover{background:var(--raised)}
.part .dot{width:7px;height:7px;border-radius:2px}
.part .pname{font-size:11.5px;font-weight:600}
.part .pshare{display:flex;align-items:center;gap:7px;font-size:10.5px;color:var(--ink-dim)}
.part .sharebar{width:52px;height:4px;border-radius:2px;background:var(--rule);overflow:hidden}
.part .sharebar i{display:block;height:100%}
.part .body{padding:0 9px 9px}
.part pre{margin:0;padding:8px;background:var(--sunken);border:1px solid var(--rule);border-radius:4px;max-height:240px;overflow:auto;font:400 11px/1.55 "IBM Plex Mono",monospace;white-space:pre-wrap;word-break:break-word}
.kbcard{border:1px solid var(--rule);border-radius:4px;margin-top:7px;overflow:hidden}
.kbcard .kbhead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 8px;background:var(--violet-bg);font-size:10.5px}
.kbcard .kbdoc{font-weight:600;color:var(--violet)}
.kbcard pre{border:0;border-radius:0}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px}
.chip{font:500 10.5px/1 "IBM Plex Mono",monospace;padding:4px 6px;border-radius:3px;background:var(--raised);border:1px solid var(--rule);color:var(--ink-dim)}
.danger{font:600 11px/1 "IBM Plex Sans",sans-serif;padding:7px 10px;border-radius:5px;cursor:pointer;background:var(--crit-bg);color:var(--crit);border:1px solid color-mix(in oklab,var(--crit) 35%,transparent)}
.danger:disabled{opacity:.45;cursor:not-allowed}
.ghost{font:600 11px/1 "IBM Plex Sans",sans-serif;padding:7px 10px;border-radius:5px;cursor:pointer;background:var(--raised);color:var(--ink);border:1px solid var(--rule)}
dialog.confirm{border:1px solid var(--rule);border-radius:10px;background:var(--surface);color:var(--ink);padding:0;max-width:490px;width:calc(100% - 32px)}
dialog.confirm::backdrop{background:rgba(6,10,16,.62)}
dialog.confirm h3{margin:0;padding:14px 16px 10px;font-size:14px;font-weight:600}
dialog.confirm .cbody{padding:0 16px 14px;font-size:12.5px;color:var(--ink-dim)}
dialog.confirm .scope{margin:10px 0;border:1px solid var(--rule);border-radius:6px;overflow:hidden}
dialog.confirm .scope div{display:flex;justify-content:space-between;gap:12px;padding:6px 10px;font-size:11.5px;border-bottom:1px solid var(--rule)}
dialog.confirm .scope div:last-child{border-bottom:0}
dialog.confirm .sk{color:var(--ink-faint)}
dialog.confirm footer{display:flex;gap:8px;justify-content:flex-end;padding:12px 16px;border-top:1px solid var(--rule);background:var(--raised)}
.empty{padding:22px 13px;color:var(--ink-dim);font-size:12.5px;text-align:center}
</style></head><body><div class="wrap">
<div class="masthead"><h1>Agent Flight Recorder</h1><span class="eyebrow" id="scope">Internal · all orgs</span></div>
<p class="sub">Every model call and tool call, with the exact body sent and the exact body returned.
Nothing is written while a customer waits. <span id="retention"></span></p>

<section class="filters">
<div class="field"><label for="f-org">Org ID</label><input id="f-org" class="mono" placeholder="00D…"></div>
<div class="field"><label for="f-user">User ID</label><input id="f-user" class="mono" placeholder="005…"></div>
<div class="field"><label for="f-agent">Agent API name</label><input id="f-agent" class="mono" placeholder="all agents"></div>
<div class="field"><label for="f-channel">Channel</label><select id="f-channel"><option value="">All</option><option>chat</option><option>record</option><option>whatsapp</option><option>flow</option></select></div>
<div class="field"><label for="f-status">Status</label><select id="f-status"><option value="">All</option><option value="error">error only</option><option value="complete">complete</option></select></div>
<div class="field"><label for="f-from">From</label><input id="f-from" class="mono" type="datetime-local"></div>
<div class="field"><label for="f-to">To</label><input id="f-to" class="mono" type="datetime-local"></div>
<div class="field"><label>&nbsp;</label><button type="button" class="ghost" id="apply">Apply filters</button></div>
</section>

<section class="stats" id="stats"></section>

<div class="panes">
<section class="panel"><header><h2>Turns</h2><span class="note" id="count"></span>
<button type="button" class="danger" id="purge" disabled>Delete matching</button></header>
<div class="rows" id="rows"><div class="empty">Loading…</div></div></section>
<section class="panel"><header><h2 id="dtitle">Turn detail</h2><span class="note mono" id="dnote"></span></header>
<div class="meta" id="meta"></div><div id="steps"><div class="empty">Select a turn.</div></div></section>
</div></div>

<dialog class="confirm" id="dlg"><h3>Delete these traces?</h3>
<div class="cbody"><p style="margin:0">Everything matching the filters now active is removed. This cannot be undone.</p>
<div class="scope" id="dlg-scope"></div>
<p style="margin:8px 0 0;font-size:11.5px" id="dlg-note"></p></div>
<footer><button type="button" class="ghost" id="dlg-cancel">Keep them</button>
<button type="button" class="danger" id="dlg-go">Delete</button></footer></dialog>

<script>
const KEY = new URLSearchParams(location.search).get('key') || '';
const KIND = {instructions:['--accent','Agent instructions'],mechanics:['--ink-faint','Runtime mechanics'],
clock:['--ink-faint','Current date and time'],kb:['--violet','Knowledge base'],record:['--ok','Record context'],
memory:['--warn','Session memory'],tools:['--crit','Tools bound'],history:['--ink-dim','Conversation history'],
user:['--accent','Latest message']};
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const j=v=>typeof v==='string'?v:JSON.stringify(v,null,2);
const ms=n=>n==null?'—':n<950?n+'ms':(n/1000).toFixed(1)+'s';
const pill=(s,t)=>'<span class="pill '+s+'">'+t+'</span>';
const $=id=>document.getElementById(id);
let CURRENT=null, MATCHED=0;

function params(){
  const p=new URLSearchParams();
  const add=(k,v)=>{if(v)p.set(k,v)};
  add('orgId',$('f-org').value.trim()); add('userId',$('f-user').value.trim());
  add('agentApiName',$('f-agent').value.trim()); add('channel',$('f-channel').value);
  add('status',$('f-status').value);
  if($('f-from').value)add('from',new Date($('f-from').value).toISOString());
  if($('f-to').value)add('to',new Date($('f-to').value).toISOString());
  return p;
}
const api=(path,init)=>fetch(path,{...init,headers:{'Authorization':'Bearer '+KEY,'Content-Type':'application/json'}});

async function load(){
  const p=params(); p.set('limit','100');
  const r=await api('/api/admin/traces?'+p.toString());
  if(!r.ok){$('rows').innerHTML='<div class="empty">Could not load — check the key in the URL.</div>';return}
  const d=await r.json();
  MATCHED=d.total;
  $('retention').textContent='Payloads are kept '+d.retention.payloadDays+' days; the numbers '+d.retention.traceDays+'.';
  $('count').textContent=d.total+' matching';
  const purge=$('purge');
  purge.disabled=d.total===0; purge.textContent='Delete '+d.total+' matching';
  const t=d.totals, cachePct=t.tokensIn?Math.round(t.cachedTokens/t.tokensIn*100):0;
  $('stats').innerHTML=[
    ['Turns',d.total,'matching filters',''],
    ['Errors',d.errors,d.total?((d.errors/d.total*100).toFixed(1)+'% of turns'):'—',d.errors?'alert':''],
    ['Avg latency',ms(t.avgLatencyMs),'per turn',''],
    ['Tokens in',t.tokensIn.toLocaleString(),cachePct+'% from cache',''],
    ['Model calls',t.modelCalls,d.total?(t.modelCalls/d.total).toFixed(1)+' per turn':'—','']
  ].map(([k,v,sub,cls])=>'<div class="stat '+cls+'"><div class="k">'+k+'</div><div class="v num">'+v+'</div><div class="d">'+sub+'</div></div>').join('');
  renderRows(d.traces);
}

function renderRows(list){
  if(!list.length){$('rows').innerHTML='<div class="empty">No turns match. Capture is on only when TRACE_CAPTURE=full.</div>';return}
  $('rows').innerHTML=list.map(t=>{
    const sev=t.status==='error'?'crit':(t.errorMessage?'warn':'ok');
    const when=new Date(t.createdAt).toLocaleString();
    return '<button class="row" data-id="'+t.id+'" aria-current="'+(t.id===CURRENT)+'">'+
      '<span class="stripe" style="background:var(--'+(sev==='ok'?'ok':sev==='warn'?'warn':'crit')+')"></span>'+
      '<span class="who"><span class="line1"><span class="agent">'+esc(t.agentName||t.agentApiName)+'</span>'+
      (t.status==='error'?pill('crit','error'):pill('ok','ok'))+'<span class="pill plain">'+esc(t.channel)+'</span></span>'+
      '<span class="line2 mono">'+when+' · '+esc(t.userId||'—')+'</span></span>'+
      '<span class="right"><span class="lat num mono">'+ms(t.latencyMs)+'</span><br>'+
      '<span class="tok num mono">'+t.tokensIn.toLocaleString()+' / '+t.tokensOut.toLocaleString()+'</span></span></button>';
  }).join('');
  $('rows').querySelectorAll('.row').forEach(b=>b.addEventListener('click',()=>open(b.dataset.id)));
}

function renderParts(parts){
  const total=parts.reduce((n,p)=>n+(p.tokens||0),0)||1;
  return '<div class="parts">'+parts.map(p=>{
    const [c,label]=KIND[p.kind]||['--ink-dim',p.kind];
    const pct=Math.round((p.tokens||0)/total*100);
    let body='';
    if(p.passages)body=p.passages.map(x=>'<div class="kbcard"><div class="kbhead"><span class="kbdoc">'+esc(x.doc)+'</span></div><pre>'+esc(x.text)+'</pre></div>').join('');
    else if(p.tools)body='<div class="chips">'+p.tools.map(t=>'<span class="chip">'+esc(t)+'</span>').join('')+'</div>';
    else body='<pre>'+esc(p.text||'')+'</pre>';
    return '<details class="part"><summary><span class="dot" style="background:var('+c+')"></span>'+
      '<span class="pname">'+esc(p.label||label)+'</span><span class="pshare">'+
      '<span class="sharebar"><i style="width:'+pct+'%;background:var('+c+')"></i></span>'+
      '<span class="num mono">'+(p.tokens||0).toLocaleString()+'</span></span></summary>'+
      '<div class="body">'+body+'</div></details>';
  }).join('')+'</div>';
}

async function open(id){
  CURRENT=id;
  document.querySelectorAll('.row').forEach(r=>r.setAttribute('aria-current',String(r.dataset.id===id)));
  const r=await api('/api/admin/traces/'+id);
  if(!r.ok){$('steps').innerHTML='<div class="empty">Could not load that turn.</div>';return}
  const {trace:t}=await r.json();
  $('dtitle').textContent=(t.agentName||t.agentApiName)+' · '+new Date(t.createdAt).toLocaleString();
  $('dnote').textContent=t.id.slice(0,8);
  $('meta').innerHTML=[['Org',t.orgId],['User ID',t.userId||'—'],['Session',t.sessionId||'—'],
    ['Record',t.recordId||'—'],['Channel',t.channel],['Latency',ms(t.latencyMs)],
    ['Tokens in / out',t.tokensIn.toLocaleString()+' / '+t.tokensOut.toLocaleString()],
    ['Cached',t.cachedTokens.toLocaleString()]]
    .map(([k,v])=>'<div><div class="k">'+k+'</div><div class="v mono">'+esc(v)+'</div></div>').join('')+
    (t.errorMessage?'<div style="grid-column:1/-1"><div class="k">Failure</div><div class="v mono" style="color:var(--crit)">'+esc(t.errorMessage)+'</div></div>':'');

  if(!t.steps.length){
    $('steps').innerHTML='<div class="empty">'+(t.payloadsPurgedAt?'Payloads for this turn have aged out. The numbers above remain.':'No steps recorded.')+'</div>';
    return;
  }
  const max=Math.max(...t.steps.map(s=>s.latencyMs||0),1);
  $('steps').innerHTML=t.steps.map((s,i)=>{
    const hasParts=Array.isArray(s.requestParts)&&s.requestParts.length>0;
    return '<details class="step"'+(i===0?' open':'')+'><summary>'+
      '<span class="seq mono">'+String(i+1).padStart(2,'0')+'</span><span>'+
      '<span class="title"><span class="mono">'+esc(s.name)+'</span>'+
      pill('plain',s.kind==='model_call'?'model call':'tool call')+(s.isError?pill('crit','failed'):'')+'</span>'+
      '<span class="subtitle">stage: '+esc(s.stage)+(s.tokensIn?' · '+s.tokensIn.toLocaleString()+' / '+s.tokensOut.toLocaleString()+' tokens':'')+
      (s.cacheRead?' · '+s.cacheRead.toLocaleString()+' cached':'')+'</span>'+
      '<span class="bar" style="margin-top:5px"><i style="width:'+Math.round((s.latencyMs||0)/max*100)+'%"></i></span></span>'+
      '<span class="timing mono"><b>'+ms(s.latencyMs)+'</b></span></summary>'+
      '<div class="payloads"><div class="payload"><h4><span>Request sent</span>'+
      (hasParts?'<span class="seg" data-step="'+i+'"><button type="button" data-v="parts" aria-pressed="true">Composed</button><button type="button" data-v="raw" aria-pressed="false">Raw JSON</button></span>':'<span>→ provider</span>')+
      '</h4>'+
      (hasParts?'<div data-view="parts" data-step="'+i+'">'+renderParts(s.requestParts)+'</div><pre data-view="raw" data-step="'+i+'" hidden>'+esc(j(s.requestJson))+'</pre>'
              :'<pre>'+esc(j(s.requestJson))+'</pre>')+
      '</div><div class="payload"><h4><span>Response received</span><span>'+(s.isError?'⚠ error':'← provider')+'</span></h4>'+
      '<pre>'+esc(s.error?s.error+'\\n\\n'+j(s.responseJson):j(s.responseJson))+'</pre></div></div></details>';
  }).join('');
  $('steps').querySelectorAll('.seg').forEach(seg=>seg.addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b)return;
    seg.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));
    $('steps').querySelectorAll('[data-view][data-step="'+seg.dataset.step+'"]').forEach(el=>{el.hidden=el.dataset.view!==b.dataset.v});
  }));
}

$('apply').addEventListener('click',load);
$('purge').addEventListener('click',()=>{
  const org=$('f-org').value.trim(), from=$('f-from').value;
  $('dlg-scope').innerHTML=[['Org',org||'— required —'],['Agent',$('f-agent').value.trim()||'all agents'],
    ['Channel',$('f-channel').value||'all channels'],['From',from||'— required —'],['To',$('f-to').value||'now']]
    .map(([k,v])=>'<div><span class="sk">'+k+'</span><span class="mono">'+esc(v)+'</span></div>').join('');
  const ok=!!org&&!!from;
  $('dlg-note').textContent=ok
    ?'Retention already clears payloads on its own — use this to purge a test run now.'
    :'A delete must name an Org ID and a From date. Set both, then try again.';
  $('dlg-go').disabled=!ok;
  $('dlg-go').textContent=ok?('Delete '+MATCHED+' turns'):'Scope required';
  $('dlg').showModal();
});
$('dlg-cancel').addEventListener('click',()=>$('dlg').close());
$('dlg-go').addEventListener('click',async()=>{
  $('dlg').close();
  const r=await api('/api/admin/traces?'+params().toString(),{method:'DELETE'});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){alert(d.message||'Delete refused.');return}
  CURRENT=null; $('steps').innerHTML='<div class="empty">Deleted '+d.deleted+' turns.</div>';
  $('meta').innerHTML=''; $('dtitle').textContent='Turn detail'; $('dnote').textContent='';
  load();
});
const since=new Date(Date.now()-24*3600*1000); since.setSeconds(0,0);
$('f-from').value=new Date(since.getTime()-since.getTimezoneOffset()*60000).toISOString().slice(0,16);
load();
</script></body></html>`;
}

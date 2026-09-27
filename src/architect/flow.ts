/**
 * AUTOMATION STEPS — the deterministic part of an automation agent.
 *
 * A conversational agent is a root model with tools the model chooses
 * between. An automation run is different: something fires, and a fixed
 * sequence follows — query these records, for each one check this, create
 * that, send an email. Leaving that sequence to a model is slower, costs a
 * model call per decision and does not run the same way twice.
 *
 * So an AgentSpec may carry `flow`: an ordered list of steps, with the
 * branches of if / loop / approval nested inside the step that owns them.
 * Nesting instead of a free graph is deliberate — a designer model writes
 * a list reliably and a graph with ports unreliably, and every nested list
 * has exactly one correct wiring, which this module derives.
 *
 * Each step compiles onto an executor the automation engine already
 * registers (src/nodes/logic.ts, action.ts, call-tool.ts, and the engine's
 * own loop handling), on the exact ports the engine routes on:
 * if → yes/no, loop → each/done, approval → approved/rejected, else out.
 *
 * The rules checked here are the engine's own limits, so a design the
 * validator passes is one the engine can run: no loop inside a loop, no
 * wait or approval inside a loop, one condition per if, and every
 * {!name.field} must name something defined earlier.
 */
import type { SpecError } from './spec';

export type FlowStep =
  | { step: 'agent' }
  | { step: 'query_records'; soql: string; as?: string }
  | { step: 'get_record'; object: string; fields?: string; as?: string }
  | { step: 'create_record'; object: string; fields: Record<string, string>; as?: string }
  | { step: 'update_record'; object: string; fields: Record<string, string>; as?: string }
  | { step: 'create_task'; subject: string; priority?: 'High' | 'Normal' | 'Low'; due?: string; as?: string }
  | { step: 'post_chatter'; message: string; as?: string }
  | { step: 'call_tool'; connector: string; tool: string; params?: Record<string, string>; as?: string }
  | { step: 'set_variable'; name: string; value: string }
  | { step: 'wait'; amount: number; unit: 'minutes' | 'hours' | 'days' }
  | { step: 'approval'; comments?: string; timeoutHours?: number; approved?: FlowStep[]; rejected?: FlowStep[] }
  | { step: 'if'; condition: string; label?: string; then?: FlowStep[]; else?: FlowStep[] }
  | { step: 'loop'; over: string; as?: string; max?: number; body: FlowStep[] };

export const FLOW_STEP_KINDS = [
  'agent', 'query_records', 'get_record', 'create_record', 'update_record', 'create_task',
  'post_chatter', 'call_tool', 'set_variable', 'wait', 'approval', 'if', 'loop',
] as const;

/** More than this is a design problem, not a flow: the engine stops a run at 50 nodes. */
export const MAX_FLOW_STEPS = 40;

/** Names the engine resolves itself, or registers per node type — a step
 *  named one of these would be shadowed or would shadow it. */
const RESERVED = new Set(['recordId', 'record', 'input', 'user', 'org', 'trigger', 'ai', 'action', 'logic', 'end', 'tool', 'catalog', 'subagent']);
/** Always resolvable, whatever the flow defines. */
const BUILT_IN_ROOTS = new Set(['recordId', 'record', 'input', 'user', 'org']);
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const CONDITION_RE = /^\s*(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$/;
const TOKEN_RE = /\{!\s*([A-Za-z_][A-Za-z0-9_]*)/g;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Every `{!root...}` root a string refers to. */
function tokenRoots(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) out.push(m[1]);
  return out;
}

/** Every text value a step reads, for the reference check. */
function textsOf(s: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ['soql', 'subject', 'message', 'value', 'comments', 'condition', 'over']) if (typeof s[k] === 'string') out.push(s[k] as string);
  for (const k of ['fields', 'params']) {
    const m = s[k];
    if (m && typeof m === 'object' && !Array.isArray(m)) for (const v of Object.values(m)) if (typeof v === 'string') out.push(v);
  }
  return out;
}

/**
 * Everything wrong with a flow, as spec errors the design stage can act on.
 * `hasConnector` vouches for a (connector, tool) pair when the org's tool
 * inventory is known; without it connector tools are not checked.
 */
export function validateFlow(flow: unknown, hasConnector?: (connector: string, tool: string) => boolean): SpecError[] {
  const errors: SpecError[] = [];
  if (flow === undefined) return errors;
  if (!Array.isArray(flow)) return [{ path: '/flow', message: '`flow` must be a list of steps' }];

  let count = 0;
  let agentSteps = 0;
  // Names defined so far, in order: a step may only read what ran before it.
  const defined = new Set<string>(BUILT_IN_ROOTS);
  // The ai alias exists once the agent step has run.
  const err = (path: string, message: string) => errors.push({ path, message });

  const walk = (steps: unknown, path: string, inLoop: boolean, scope: Set<string>) => {
    if (steps === undefined) return;
    if (!Array.isArray(steps)) { err(path, 'must be a list of steps'); return; }
    steps.forEach((raw, i) => {
      const p = `${path}/${i}`;
      if (!raw || typeof raw !== 'object') { err(p, 'each step must be an object with a `step` kind'); return; }
      const s = raw as Record<string, unknown>;
      const kind = str(s.step);
      count++;
      if (!(FLOW_STEP_KINDS as readonly string[]).includes(kind)) {
        err(`${p}/step`, `unknown step '${kind || '(none)'}' — use one of ${FLOW_STEP_KINDS.join(', ')}`);
        return;
      }

      // References: only to names defined earlier in this path.
      for (const t of textsOf(s)) {
        for (const root of tokenRoots(t)) {
          if (root === 'ai' && agentSteps === 0) {
            err(p, `{!ai...} is read before the agent step has run — put an { "step": "agent" } earlier in the flow`);
          } else if (root !== 'ai' && !scope.has(root)) {
            err(p, `{!${root}...} does not name anything defined earlier — name the step that produces it with \`as\` (or \`name\` for set_variable), or use {!recordId}`);
          }
        }
      }

      const need = (k: string, what: string) => { if (!str(s[k])) err(`${p}/${k}`, `${kind} needs ${what}`); };
      const nameIt = (k: 'as' | 'name', required: boolean) => {
        const n = str(s[k]);
        if (!n) { if (required) err(`${p}/${k}`, `${kind} needs a \`${k}\``); return; }
        if (!NAME_RE.test(n)) err(`${p}/${k}`, `'${n}' is not a usable name — letters, digits and _ only, starting with a letter`);
        else if (RESERVED.has(n)) err(`${p}/${k}`, `'${n}' is reserved by the engine — pick another name`);
        else scope.add(n);
      };
      const fieldMap = (k: string, required: boolean) => {
        const m = s[k];
        const ok = m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).length > 0;
        if (!ok) { if (required) err(`${p}/${k}`, `${kind} needs \`${k}\`: an object of field API name to value`); return; }
        for (const [f, v] of Object.entries(m as Record<string, unknown>)) {
          if (typeof v !== 'string') err(`${p}/${k}/${f}`, 'every value must be a string (use "{!name.Field}" or plain text)');
        }
      };

      switch (kind) {
        case 'agent':
          agentSteps++;
          if (agentSteps > 1) err(p, 'the agent step can appear only once — it is the one AI node');
          break;
        case 'query_records':
          need('soql', 'a SOQL query');
          if (str(s.soql) && !/^select\s/i.test(str(s.soql))) err(`${p}/soql`, 'must be a SOQL SELECT');
          nameIt('as', true);
          break;
        case 'get_record':
          need('object', 'the object API name');
          nameIt('as', true);
          break;
        case 'create_record':
          need('object', 'the object API name');
          fieldMap('fields', true);
          nameIt('as', false);
          break;
        case 'update_record':
          need('object', 'the object API name');
          fieldMap('fields', true);
          nameIt('as', false);
          break;
        case 'create_task':
          need('subject', 'a subject');
          nameIt('as', false);
          break;
        case 'post_chatter':
          need('message', 'the post text');
          nameIt('as', false);
          break;
        case 'call_tool':
          need('connector', 'the connector key (for example gmail or outlook)');
          need('tool', 'the tool name, copied from `available`');
          fieldMap('params', false);
          if (hasConnector && str(s.connector) && str(s.tool) && !hasConnector(str(s.connector), str(s.tool))) {
            err(`${p}/tool`, `'${str(s.tool)}' was not found on connector '${str(s.connector)}' — copy a tool name from \`available\`, or connect that connector first`);
          }
          nameIt('as', false);
          break;
        case 'set_variable':
          nameIt('name', true);
          need('value', 'a value');
          break;
        case 'wait':
          if (inLoop) err(p, 'a wait cannot run inside a loop — the engine refuses it');
          if (!(Number(s.amount) > 0)) err(`${p}/amount`, 'wait needs an amount above 0');
          if (!['minutes', 'hours', 'days'].includes(str(s.unit))) err(`${p}/unit`, 'unit must be minutes, hours or days');
          break;
        case 'approval':
          if (inLoop) err(p, 'an approval cannot run inside a loop — the engine refuses it');
          walk(s.approved, `${p}/approved`, inLoop, new Set(scope));
          walk(s.rejected, `${p}/rejected`, inLoop, new Set(scope));
          break;
        case 'if': {
          need('condition', 'a condition');
          const c = str(s.condition);
          if (c && !CONDITION_RE.test(c)) err(`${p}/condition`, "one comparison only: <value> == != > < >= <= <value>, e.g. \"{!deal.Amount} >= 50000\" or \"{!acct.Rating} == 'Hot'\"");
          if (c && /\s(and|or|&&|\|\|)\s/i.test(c)) err(`${p}/condition`, 'one comparison per if — nest a second if inside `then` for AND');
          if ((!Array.isArray(s.then) || s.then.length === 0) && (!Array.isArray(s.else) || s.else.length === 0)) {
            err(p, 'an if needs steps in `then` or `else`');
          }
          walk(s.then, `${p}/then`, inLoop, new Set(scope));
          walk(s.else, `${p}/else`, inLoop, new Set(scope));
          break;
        }
        case 'loop': {
          if (inLoop) err(p, 'a loop cannot run inside another loop — the engine refuses it');
          need('over', 'the list to go through, e.g. "{!deals.records}"');
          const over = str(s.over);
          if (over && !/^\{![^}]+\}$/.test(over)) err(`${p}/over`, 'must be exactly one {!name.records} reference');
          const item = str(s.as) || 'item';
          const body = new Set(scope);
          if (!NAME_RE.test(item) || RESERVED.has(item)) err(`${p}/as`, `'${item}' cannot name the loop item`);
          else body.add(item);
          if (!Array.isArray(s.body) || s.body.length === 0) err(`${p}/body`, 'a loop needs steps in `body`');
          walk(s.body, `${p}/body`, true, body);
          break;
        }
      }
    });
  };

  walk(flow, '/flow', false, defined);
  if (count > MAX_FLOW_STEPS) err('/flow', `${count} steps is more than ${MAX_FLOW_STEPS} — the engine stops a run at 50 nodes; split the work`);
  return errors;
}

// ── Compile ──────────────────────────────────────────────────────────

export interface FlowNodeOut {
  name: string;
  nodeType: 'logic' | 'action';
  nodeSubType: string;
  config: Record<string, unknown>;
  x: number;
  y: number;
}
/** An exit waiting for whatever comes next: a flow node's index, 'agent'
 *  for the root AI node, or 'start' for the node the flow is entered from. */
export interface FlowExit { from: number | 'agent' | 'start'; port: string }
export interface FlowEdgeOut { from: number | 'agent' | 'start'; port: string; to: number | 'agent' }

const LABELS: Record<string, string> = {
  query_records: 'Query records', get_record: 'Get record', create_record: 'Create record', update_record: 'Update record',
  create_task: 'Create task', post_chatter: 'Post to Chatter', call_tool: 'Call tool', set_variable: 'Set variable',
  wait: 'Wait', approval: 'Approval', if: 'If / else', loop: 'Loop',
};

function nodeFor(s: FlowStep): Omit<FlowNodeOut, 'x' | 'y'> | null {
  const as = 'as' in s && s.as ? s.as : '';
  const label = (fallback: string) => ('label' in s && s.label ? s.label : fallback);
  switch (s.step) {
    case 'agent': return null;
    case 'query_records': return { name: as ? `Query ${as}` : LABELS.query_records, nodeType: 'action', nodeSubType: 'query_records', config: { soql: s.soql, outputVariable: as } };
    case 'get_record': return { name: `Get ${s.object}`, nodeType: 'action', nodeSubType: 'get_record', config: { objectType: s.object, fields: s.fields || 'Id,Name', outputVariable: as } };
    case 'create_record': return { name: `Create ${s.object}`, nodeType: 'action', nodeSubType: 'create_record', config: { objectType: s.object, fieldMappings: JSON.stringify(s.fields, null, 2), outputVariable: as } };
    case 'update_record': return { name: `Update ${s.object}`, nodeType: 'action', nodeSubType: 'update_record', config: { objectType: s.object, fieldMappings: JSON.stringify(s.fields, null, 2), outputVariable: as } };
    case 'create_task': return { name: LABELS.create_task, nodeType: 'action', nodeSubType: 'create_task', config: { subject: s.subject, priority: s.priority ?? 'Normal', dueDate: s.due ?? 'TODAY+1', outputVariable: as } };
    case 'post_chatter': return { name: LABELS.post_chatter, nodeType: 'action', nodeSubType: 'post_chatter', config: { message: s.message, outputVariable: as } };
    case 'call_tool': return { name: `${s.connector} · ${s.tool}`, nodeType: 'action', nodeSubType: 'call_tool', config: { provider: s.connector, toolName: s.tool, toolKind: 'standard', paramValues: s.params ?? {}, outputVariable: as } };
    case 'set_variable': return { name: `Set ${s.name}`, nodeType: 'logic', nodeSubType: 'set_variable', config: { variableName: s.name, template: s.value } };
    case 'wait': return { name: `Wait ${s.amount} ${s.unit}`, nodeType: 'logic', nodeSubType: 'wait', config: { delayValue: s.amount, delayUnit: s.unit } };
    case 'approval': return { name: LABELS.approval, nodeType: 'logic', nodeSubType: 'approval', config: { processDefinitionId: '', comments: s.comments ?? '', timeoutHours: s.timeoutHours ?? 48 } };
    case 'if': return { name: label(LABELS.if), nodeType: 'logic', nodeSubType: 'if_else', config: { condition: s.condition } };
    case 'loop': return { name: `For each ${s.as || 'item'}`, nodeType: 'logic', nodeSubType: 'loop', config: { collectionVar: s.over, iteratorVar: s.as || 'item', maxIterations: Math.min(Math.max(1, Number(s.max) || 25), 100) } };
  }
}

/**
 * Turn a validated flow into nodes and port-exact edges.
 *
 * `start` is where the flow is entered from (the trigger). Steps run left
 * to right; a branch drops to its own row. Whatever follows an if runs
 * after either branch (an empty branch goes straight on); whatever follows
 * a loop runs once the loop is done; whatever follows an approval runs
 * only when approved — a rejected branch ends by itself.
 */
export function compileFlow(flow: FlowStep[], start: FlowExit[], origin: { x: number; y: number }): { nodes: FlowNodeOut[]; edges: FlowEdgeOut[]; usesAgent: boolean } {
  const nodes: FlowNodeOut[] = [];
  const edges: FlowEdgeOut[] = [];
  let usesAgent = false;
  let row = 0;
  const COL = 280, ROW = 170;

  const seq = (steps: FlowStep[] | undefined, entries: FlowExit[], col: number, rowAt: number): { exits: FlowExit[]; col: number } => {
    let open = entries;
    let c = col;
    for (const s of steps ?? []) {
      let at: number | 'agent';
      if (s.step === 'agent') {
        usesAgent = true;
        at = 'agent';
      } else {
        const n = nodeFor(s)!;
        nodes.push({ ...n, x: origin.x + c * COL, y: origin.y + rowAt * ROW });
        at = nodes.length - 1;
      }
      for (const e of open) edges.push({ from: e.from, port: e.port, to: at });
      c++;
      if (s.step === 'if') {
        const yes = seq(s.then, [{ from: at, port: 'yes' }], c, rowAt);
        const noRow = ++row;
        const no = seq(s.else, [{ from: at, port: 'no' }], c, noRow);
        open = [...yes.exits, ...no.exits];
        c = Math.max(yes.col, no.col);
      } else if (s.step === 'loop') {
        const bodyRow = ++row;
        seq(s.body, [{ from: at, port: 'each' }], c, bodyRow);
        open = [{ from: at, port: 'done' }];
      } else if (s.step === 'approval') {
        const ok = seq(s.approved, [{ from: at, port: 'approved' }], c, rowAt);
        if (s.rejected?.length) seq(s.rejected, [{ from: at, port: 'rejected' }], c, ++row);
        open = ok.exits;
        c = ok.col;
      } else {
        open = [{ from: at, port: 'out' }];
      }
    }
    return { exits: open, col: c };
  };

  seq(flow, start, 0, 0);
  return { nodes, edges, usesAgent };
}

/** One line per step, indented by branch — what the reviewer and the build report read. */
export function describeFlow(flow: FlowStep[] | undefined, depth = 0): string[] {
  const pad = '  '.repeat(depth);
  const out: string[] = [];
  for (const s of flow ?? []) {
    switch (s.step) {
      case 'agent': out.push(`${pad}- AI agent step (its answer is {!ai.finalText})`); break;
      case 'query_records': out.push(`${pad}- Query → ${s.as}: ${s.soql}`); break;
      case 'get_record': out.push(`${pad}- Get ${s.object} (${s.fields || 'Id,Name'}) → ${s.as}`); break;
      case 'create_record': out.push(`${pad}- Create ${s.object} ${JSON.stringify(s.fields)}`); break;
      case 'update_record': out.push(`${pad}- Update ${s.object} ${JSON.stringify(s.fields)}`); break;
      case 'create_task': out.push(`${pad}- Task "${s.subject}" due ${s.due ?? 'TODAY+1'}`); break;
      case 'post_chatter': out.push(`${pad}- Chatter post "${s.message}"`); break;
      case 'call_tool': out.push(`${pad}- ${s.connector}.${s.tool} ${JSON.stringify(s.params ?? {})}`); break;
      case 'set_variable': out.push(`${pad}- Set ${s.name} = ${s.value}`); break;
      case 'wait': out.push(`${pad}- Wait ${s.amount} ${s.unit}`); break;
      case 'approval':
        out.push(`${pad}- Approval (${s.timeoutHours ?? 48}h)`, `${pad}  approved:`, ...describeFlow(s.approved, depth + 2));
        if (s.rejected?.length) out.push(`${pad}  rejected:`, ...describeFlow(s.rejected, depth + 2));
        break;
      case 'if':
        out.push(`${pad}- If ${s.condition}`, `${pad}  then:`, ...describeFlow(s.then, depth + 2));
        if (s.else?.length) out.push(`${pad}  else:`, ...describeFlow(s.else, depth + 2));
        break;
      case 'loop': out.push(`${pad}- For each ${s.as || 'item'} in ${s.over} (max ${s.max ?? 25}):`, ...describeFlow(s.body, depth + 1)); break;
    }
  }
  return out;
}

/** What the design stage is told about steps, for an automation agent only. */
export const FLOW_INSTRUCTION =
  'THIS IS AN AUTOMATION AGENT. Something fires it and a fixed sequence follows, so put the sequence in `flow` ' +
  '(top level, beside nodes and edges): an ordered list of steps, each {"step": kind, ...}. Deterministic steps are ' +
  'cheaper, faster and repeatable; use the agent step ONLY where judgement or writing is needed (scoring, summarising, ' +
  'drafting an email), and leave it out entirely when the work is pure data handling.\n' +
  'Steps:\n' +
  '  {"step":"agent"} — runs the root agent once; later steps read its answer as {!ai.finalText}.\n' +
  '  {"step":"get_record","object":"Account","fields":"Id,Name,OwnerId","as":"acct"} — reads the record the run started on.\n' +
  '  {"step":"query_records","soql":"SELECT Id, Name, Amount, CloseDate FROM Opportunity WHERE AccountId = \'{!recordId}\' AND IsClosed = false","as":"deals"} — result {!deals.records} (a list) and {!deals.count}.\n' +
  '  {"step":"loop","over":"{!deals.records}","as":"deal","max":25,"body":[...]} — body runs per item; read it as {!deal.Field}. Steps after the loop run once, when it is done.\n' +
  '  {"step":"if","condition":"{!deal.Amount} >= 50000","then":[...],"else":[...]} — ONE comparison (== != > < >= <=); text in single quotes. Nest a second if for AND. Steps after the if run after either branch.\n' +
  '  {"step":"create_record","object":"Task","fields":{"Subject":"Follow up {!deal.Name}","WhatId":"{!deal.Id}"}}\n' +
  '  {"step":"update_record","object":"Opportunity","fields":{"Next_Step__c":"{!ai.finalText}"}} — updates the record the run started on only.\n' +
  '  {"step":"create_task","subject":"...","priority":"High","due":"TODAY+3"} — a Task on the record the run started on.\n' +
  '  {"step":"post_chatter","message":"..."} — on the record the run started on.\n' +
  '  {"step":"call_tool","connector":"gmail","tool":"<name from available>","params":{"to":"...","subject":"...","body":"{!ai.finalText}"}} — sends email or calls any connected tool. Copy connector and tool names from `available`.\n' +
  '  {"step":"set_variable","name":"summary","value":"..."} — read later as {!summary.value}.\n' +
  '  {"step":"wait","amount":2,"unit":"days"} and {"step":"approval","comments":"...","approved":[...],"rejected":[...]} — never inside a loop; steps after an approval run only when approved.\n' +
  'Rules: no loop inside a loop. {!recordId} is the record the run started on; to use its fields, get_record it first. ' +
  'Every {!name...} must be a name an EARLIER step set with `as` (or `name`); {!record.x} is only the raw trigger payload — do not rely on it. ' +
  'The agent node still exists as the root in `nodes`; its instructions say what it decides or writes when the agent step runs.';

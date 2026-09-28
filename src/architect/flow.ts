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
import type { AgentSpec, SpecError } from './spec';
import { conditionProblems, tokenPaths } from '../orchestrator/expressions';
import { parseFieldSpec, type OutputField } from '../orchestrator/structured-output';

export type FlowStep =
  | { step: 'agent' }
  /** An AI step: its own prompt, and named outputs later steps read as {!as.field}. */
  | { step: 'ai'; as: string; prompt: string; outputs: Record<string, string>; tier?: 'small' | 'medium' | 'large' }
  | { step: 'query_records'; soql: string; as?: string }
  | { step: 'get_record'; object: string; id?: string; fields?: string; as?: string }
  | { step: 'create_record'; object: string; fields: Record<string, string>; as?: string }
  | { step: 'update_record'; object: string; id?: string; fields: Record<string, string>; as?: string }
  | { step: 'create_task'; subject: string; priority?: 'High' | 'Normal' | 'Low'; due?: string; as?: string }
  | { step: 'post_chatter'; message: string; as?: string }
  | { step: 'call_tool'; connector: string; tool: string; params?: Record<string, string>; as?: string }
  | { step: 'set_variable'; name: string; value: string }
  | { step: 'wait'; amount: number; unit: 'minutes' | 'hours' | 'days' }
  | { step: 'approval'; comments?: string; timeoutHours?: number; approved?: FlowStep[]; rejected?: FlowStep[] }
  | { step: 'if'; condition: string; label?: string; then?: FlowStep[]; else?: FlowStep[] }
  | { step: 'loop'; over: string; as?: string; max?: number; body: FlowStep[] };

export const FLOW_STEP_KINDS = [
  'agent', 'ai', 'query_records', 'get_record', 'create_record', 'update_record', 'create_task',
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
const TOKEN_RE = /\{!((?:[^{}]|\{[^{}]*\})+)\}/g;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The root name of every path a string's {! … } tokens read — functions
 *  (DAYS_BETWEEN, FORMAT_NUMBER, …) and TODAY are not names. */
function tokenRoots(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) for (const path of tokenPaths(m[1])) out.push(path.split('.')[0]);
  return out;
}

/** Every full path (root.field) a string's {! … } tokens read. */
function tokenFullPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) out.push(...tokenPaths(m[1]));
  return out;
}

/** Every text value a step reads, for the reference check. */
function textsOf(s: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ['soql', 'subject', 'message', 'value', 'comments', 'condition', 'over', 'id', 'prompt']) if (typeof s[k] === 'string') out.push(s[k] as string);
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
  // An AI step's name → the outputs it declared.
  const fieldsOf = new Map<string, Set<string>>();
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

      // References: only to names defined earlier in this path — and to an
      // AI step, only to the outputs it declared.
      for (const t of textsOf(s)) {
        for (const root of tokenRoots(t)) {
          if (root === 'ai' && agentSteps === 0) {
            err(p, `{!ai...} is read before the agent step has run — put an { "step": "agent" } earlier in the flow`);
          } else if (root !== 'ai' && !scope.has(root)) {
            err(p, `{!${root}...} does not name anything defined earlier — name the step that produces it with \`as\` (or \`name\` for set_variable), or use {!recordId}`);
          }
        }
        for (const path of tokenFullPaths(t)) {
          const [root, field] = path.split('.');
          const known = fieldsOf.get(root);
          if (known && field && !known.has(field)) err(p, `{!${root}.${field}} — the AI step "${root}" has no output "${field}"; its outputs are ${[...known].filter(f => f !== 'finalText').join(', ')}`);
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
        case 'ai': {
          need('prompt', 'a prompt: what to read (with {! } values) and what to decide or write');
          nameIt('as', true);
          const outs = s.outputs && typeof s.outputs === 'object' && !Array.isArray(s.outputs) ? Object.entries(s.outputs as Record<string, unknown>) : [];
          if (outs.length === 0) err(`${p}/outputs`, 'an AI step needs `outputs`: each field it returns, e.g. {"mood":"choice: interested | cooling off | blocked","reason":"text: one sentence"}');
          const names = new Set<string>(['finalText']);
          for (const [k, v] of outs) {
            const f = parseFieldSpec(k, String(v ?? ''));
            if (typeof f === 'string') err(`${p}/outputs/${k}`, f); else names.add(f.name);
          }
          if (str(s.as)) fieldsOf.set(str(s.as), names);
          break;
        }
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
          if (c) for (const problem of conditionProblems(c)) err(`${p}/condition`, `${problem} — a condition is comparisons joined by AND / OR, e.g. "{!deal.Amount} >= 50000 AND {!DAYS_BETWEEN(deal.LastActivityDate, TODAY)} >= 14"`);
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
  nodeType: 'logic' | 'action' | 'ai';
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
    case 'ai': {
      const outputs: OutputField[] = [];
      for (const [k, v] of Object.entries(s.outputs ?? {})) { const f = parseFieldSpec(k, String(v)); if (typeof f !== 'string') outputs.push(f); }
      // The compiler fills in the engine and model; a step is marked so the
      // canvas draws it as a step, not as the agent's root.
      return { name: `AI: ${s.as}`, nodeType: 'ai', nodeSubType: 'gpt4', config: { step: true, instruction: s.prompt, outputs, outputVariable: s.as, tier: s.tier ?? 'medium' } };
    }
    case 'query_records': return { name: as ? `Query ${as}` : LABELS.query_records, nodeType: 'action', nodeSubType: 'query_records', config: { soql: s.soql, outputVariable: as } };
    case 'get_record': return { name: `Get ${s.object}`, nodeType: 'action', nodeSubType: 'get_record', config: { objectType: s.object, ...(s.id ? { recordId: s.id } : {}), fields: s.fields || 'Id,Name', outputVariable: as } };
    case 'create_record': return { name: `Create ${s.object}`, nodeType: 'action', nodeSubType: 'create_record', config: { objectType: s.object, fieldMappings: JSON.stringify(s.fields, null, 2), outputVariable: as } };
    case 'update_record': return { name: `Update ${s.object}`, nodeType: 'action', nodeSubType: 'update_record', config: { objectType: s.object, ...(s.id ? { recordId: s.id } : {}), fieldMappings: JSON.stringify(s.fields, null, 2), outputVariable: as } };
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
      case 'ai': out.push(`${pad}- AI step → ${s.as} {${Object.entries(s.outputs ?? {}).map(([k, v]) => `${k}: ${v}`).join('; ')}}: ${s.prompt}`); break;
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
  'THIS IS AN AUTOMATION AGENT, AND ITS WORK GOES ON THE CANVAS AS STEPS. Something fires it and a fixed sequence follows. Put that ' +
  'sequence in `flow` (top level, beside nodes and edges): an ordered list of steps, each {"step": kind, ...}, with the branches of ' +
  'if / loop / approval nested inside them. EVERY read, loop, rule, branch, calculation, record write, post and email the requirement ' +
  'states is a step — the person reviews and edits them on the canvas, and the engine runs them the same way every time. ' +
  'WHERE JUDGEMENT OR WRITING IS NEEDED (classify, score, read a thread and decide, extract facts, draft an email body), use an AI STEP with ' +
  'named outputs, then branch on those outputs with an if — exactly like an LLM node with a structured output parser followed by an If node. ' +
  'Use as many AI steps as the work needs, each with one clear job. A design whose logic lives in an agent\'s instructions instead of ' +
  'steps is wrong for an automation agent.\n' +
  'STEPS\n' +
  '  {"step":"get_record","object":"Account","id":"{!opp.AccountId}","fields":"Id,Name,OwnerId,Type","as":"acct"} — reads one record; without "id" it reads the record the run started on.\n' +
  '  {"step":"query_records","soql":"SELECT Id, Name, Amount, CloseDate, OwnerId, Owner.Email FROM Opportunity WHERE AccountId = \'{!recordId}\' AND IsClosed = false","as":"deals"} — {!deals.records} is the list, {!deals.count} how many.\n' +
  '  {"step":"loop","over":"{!deals.records}","as":"deal","max":50,"body":[...]} — the body runs once per record, reading it as {!deal.Field}; steps after the loop run once, when it is done.\n' +
  '  {"step":"if","condition":"...","then":[...],"else":[...]} — steps after the if run after either branch. For "the first rule that matches", put the next rule inside `else`.\n' +
  '  {"step":"create_record","object":"Task","fields":{"Subject":"...","WhatId":"{!deal.Id}","OwnerId":"{!deal.OwnerId}","ActivityDate":"{!ADD_BUSINESS_DAYS(TODAY, 3)}","Priority":"High"},"as":"task"} — any object: Task, Opportunity, OpportunityContactRole, FeedItem (a Chatter post: ParentId + Body), …\n' +
  '  {"step":"update_record","object":"Account","id":"{!acct.Id}","fields":{"Rating":"Hot"}} — updates that record; without "id", the record the run started on.\n' +
  '  {"step":"call_tool","connector":"<key from available.mcp>","tool":"<tool name from available.mcp>","params":{"to":"{!deal.Owner.Email}","subject":"...","body":"..."}} — email and any other connector tool. A connector marked connected:false can still be used: the step is skipped with a note until someone connects it, and a setup item says so.\n' +
  '  {"step":"set_variable","name":"summary","value":"..."} — read later as {!summary.value}.\n' +
  '  {"step":"ai","as":"judge","prompt":"Deal {!deal.Name}, stage {!deal.StageName}, last activity {!deal.LastActivityDate}. Latest customer email: {!thread.result}. Decide how the customer feels about the deal.",' +
  '"outputs":{"mood":"choice: interested | cooling off | blocked | no reply","reason":"text: one sentence naming the facts used","risk":"number: 0-100"},"tier":"medium"} ' +
  '— its own prompt (every value it needs goes in with {! }), and named outputs later steps read as {!judge.mood}, {!judge.reason}, {!judge.risk}. ' +
  'Output types: text, number, boolean, date, choice: a | b | c (add " — meaning" to explain). Branch on them: {"step":"if","condition":"{!judge.mood} == \'blocked\' OR {!judge.risk} >= 70",...}. ' +
  'For an email body the AI writes, give it an output like "body":"text: the email body, plain, under 120 words" and use {!writer.body}. tier: small for simple classification, medium by default, large for careful writing or hard judgement.\n' +
  '  {"step":"agent"} — runs the root agent (with its tools) once; later steps read its answer as {!ai.finalText}. Only for work where the model must choose tools itself.\n' +
  '  {"step":"wait","amount":2,"unit":"days"} and {"step":"approval","comments":"...","approved":[...],"rejected":[...]} — never inside a loop; steps after an approval run only when approved. Use approval only when the requirement asks for one.\n' +
  'VALUES inside {! }: a path (deal.CloseDate, recordId, deals.count) or a function — TODAY, ADD_DAYS(date, n), ADD_BUSINESS_DAYS(date, n), ' +
  'ADD_MONTHS(date, n), DAYS_BETWEEN(from, to), YEAR(date), FORMAT_NUMBER(n) (thousands separators, no decimals), COUNT(list), ' +
  'SUM(list, \'Field\'). They nest: {!YEAR(ADD_MONTHS(opp.CloseDate, 12))}. Use them in text, field values and conditions.\n' +
  'CONDITIONS: comparisons joined by AND / OR (AND binds first). A comparison is <a> == != > < >= <= <b>, <a> contains <b>, <a> is blank, ' +
  'or <a> is not blank. Dates compare as dates and numbers as numbers; text goes in single quotes. Example: ' +
  '"{!deal.CloseDate} < {!TODAY} AND {!deal.StageName} != \'Closed Lost\'" or "{!DAYS_BETWEEN(deal.LastActivityDate, TODAY)} >= 14 OR {!deal.LastActivityDate} is blank".\n' +
  'DUPLICATES: when the requirement says a re-run must not create something twice, query for it first (query_records with the exact name or subject) ' +
  'and put the create inside an if on {!found.count} == 0.\n' +
  'SHARED STEPS: a step that happens whatever rule matched ("in every case", "whatever happens", "always") goes ONCE, after the if — steps after an ' +
  'if run after either branch. Never copy it into each branch: the path where no rule matches would miss it.\n' +
  'ONLY WHAT IS ASKED: add no step the requirement does not need. Salesforce fills defaults itself (a Task\'s Status, a record\'s Owner); never add a ' +
  'schema lookup, a query or an AI step just to choose a default value.\n' +
  'RULES: no loop inside a loop. {!recordId} is the record the run started on; get_record it to use its fields. Every {!name...} must be ' +
  'a name an EARLIER step set with `as` (or `name`); {!record.x} is only the raw trigger payload — do not rely on it. The root agent ' +
  'still exists in `nodes`; its instructions say what it decides or writes when an agent step runs.';

/** Whether any step, in any branch, runs the root agent. */
export function flowUsesAgent(flow: unknown): boolean {
  if (!Array.isArray(flow)) return false;
  return (flow as Array<Record<string, unknown>>).some(s =>
    s?.step === 'agent' || ['then', 'else', 'body', 'approved', 'rejected'].some(k => flowUsesAgent(s?.[k])));
}

/**
 * THE SAME STEP COPIED INTO SEVERAL BRANCHES OF ONE RULE CHAIN.
 *
 * "Whatever rule matched, set NextStep" came out as the update inside each
 * rule's branch — three copies, and none on the path where no rule matches,
 * so those records were never updated. A step that belongs to every outcome
 * goes once, after the if. This finds the copies (identical last step of
 * two or more branches of an if / else-if chain) and whether the no-match
 * path lacks it, for the reviewer to judge against the requirement.
 */
export function repeatedBranchTails(flow: unknown, path = 'flow'): string[] {
  const notes: string[] = [];
  if (!Array.isArray(flow)) return notes;
  (flow as Array<Record<string, unknown>>).forEach((s, i) => {
    const here = `${path}[${i}]`;
    if (s?.step === 'if') {
      // Walk the chain: then-branches of each if, and the final else.
      const branches: unknown[][] = [];
      let cur: Record<string, unknown> | undefined = s;
      let finalElse: unknown[] | null = null;
      while (cur) {
        branches.push(Array.isArray(cur.then) ? (cur.then as unknown[]) : []);
        const els: Array<Record<string, unknown>> = Array.isArray(cur.else) ? (cur.else as Array<Record<string, unknown>>) : [];
        if (els.length === 1 && els[0]?.step === 'if') { cur = els[0]; continue; }
        finalElse = els.length ? els : null;
        cur = undefined;
      }
      if (finalElse) branches.push(finalElse);
      // Inside the branches, look for chains of their own; the chain's own
      // else-ifs are part of this one and are not reported again.
      branches.forEach((b, bi) => notes.push(...repeatedBranchTails(b, `${here}.branch${bi + 1}`)));
      const tails = branches.map(b => (b.length ? JSON.stringify(b[b.length - 1]) : null));
      const counts = new Map<string, number>();
      for (const t of tails) if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const [t, n] of counts) {
        if (n < 2) continue;
        const step = JSON.parse(t) as Record<string, unknown>;
        const what = `${String(step.step)}${step.object ? ` ${String(step.object)}` : ''}`;
        notes.push(`${here}: the same ${what} step ends ${n} of the ${branches.length} branches of this rule chain` +
          (finalElse ? '' : ', and the path where no rule matches does not have it') +
          ' — if it must happen whatever the outcome, it belongs once after the if.');
      }
      return;
    }
    for (const k of ['body', 'approved', 'rejected']) notes.push(...repeatedBranchTails(s?.[k], `${here}.${k}`));
  });
  return notes;
}

/** The agent node of an automation that runs only as steps. */
export const STEPS_ONLY_ROOT =
  'This automation runs as the steps on its canvas. This agent node is its identity for the Flow action and the setup list; none of the steps calls it.';

/**
 * AN AUTOMATION MADE ONLY OF STEPS DOES NOT NEED AN AGENT WITH TOOLS.
 *
 * The designer still drew the root agent with a full tool set and a nine-
 * thousand-character prompt, none of it reachable from the trigger: the
 * canvas showed an agent wired to nothing, every build paid to write its
 * instructions, and a disabled Gmail tool hung off it. When no step runs
 * the agent, it keeps only its node (the Flow action and the setup list
 * need one) with a fixed line saying so.
 */
export function pruneForSteps(spec: AgentSpec, agentType: string | undefined): string | null {
  if (agentType !== 'automation' || !Array.isArray(spec?.flow) || spec.flow.length === 0 || flowUsesAgent(spec.flow)) return null;
  const root = spec.nodes.find(n => n.type === 'agent');
  if (!root) return null;
  const dropped = spec.nodes.filter(n => n.type !== 'agent').length;
  if (dropped === 0 && root.instructions === STEPS_ONLY_ROOT) return null;
  spec.nodes = [root];
  spec.edges = [];
  root.instructions = STEPS_ONLY_ROOT;
  if (spec.architecture) spec.architecture = { ...spec.architecture, subAgentCount: 0 };
  return dropped > 0
    ? `This automation runs entirely as steps, so its agent node carries no tools or helpers (${dropped} left out).`
    : null;
}

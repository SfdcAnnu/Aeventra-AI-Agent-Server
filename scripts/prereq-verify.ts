/**
 * prereq-verify — the Gap Reporter's output always reaches the final gate
 * schema-valid.
 *
 * This exists because the alternative failed in production: the Gap
 * Reporter is not given the AgentSpec schema, so it emits whatever shape
 * the request implies, and `additionalProperties: false` rejected it at the
 * LAST stage of a seven-stage build the customer had already paid for in
 * full. Asking a model to match an unseen schema is not a guarantee. This
 * suite is the guarantee.
 *
 * Every case below asserts the same thing: whatever went in, what comes out
 * validates — and the gap is still described, because a gap the customer is
 * never told about is the worst outcome this system can produce.
 *
 *   npx tsx scripts/prereq-verify.ts
 */
import {
  normalizePrerequisite, normalizePrerequisites, validateSpecSchema,
  attachOrphansToRoot, validateSpecLogic, type AgentSpec,
} from '../src/architect/spec';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** The real test: does the full spec pass the schema with these attached? */
function schemaAccepts(prerequisites: unknown): string[] {
  const spec = {
    specVersion: '1.0',
    name: 'Probe',
    department: 'Sales',
    trigger: { type: 'manual' },
    nodes: [{ id: 'root', type: 'agent', label: 'Root', instructions: 'Be useful.' }],
    edges: [],
    prerequisites,
  } as unknown as AgentSpec;
  return validateSpecSchema(spec)
    .filter(e => e.path.includes('prerequisite'))
    .map(e => `${e.path}: ${e.message}`);
}

// ── 1. The exact production failure ──────────────────────────────────
console.log('\n1. The shape that killed a paid-for build now validates');
// Reconstructed from the live error: missing kind/title/assignee/status,
// and two properties the schema does not allow.
const LIVE_FAILURE = [
  {
    id: 'PRE-001',
    capability: 'Log an activity against an opportunity',
    reason: 'No invocable Apex or Flow in the org creates a Task from the agent.',
    resolution: 'Build an invocable Apex method that creates a Task. Expose it to the integration user.',
    owner: 'apex developer',
    severity: 'blocking',
  },
  {
    id: 'PRE-002',
    capability: 'Forecast field coverage check',
    reason: 'The forecast fields the requirement names do not exist on Opportunity.',
    resolution: 'Create the fields, then tell Archon.',
    owner: 'admin',
    severity: 'optional',
  },
];
const fixed = normalizePrerequisites(LIVE_FAILURE);
const liveErrors = schemaAccepts(fixed);
check('the live failure now passes the schema', liveErrors.length === 0, liveErrors.join('; '));
check('both gaps survive — neither is dropped', fixed.length === 2);
check('the description is carried over, not invented',
  fixed[0].why.includes('invocable Apex') && fixed[0].title.includes('Log an activity'));
check('"apex developer" maps onto the assignee enum', fixed[0].assignee === 'apex_developer');
check('"admin" maps onto the assignee enum', fixed[1].assignee === 'salesforce_admin');
check('the kind is inferred from the text', fixed[0].kind === 'invocable_apex', fixed[0].kind);
check('a field gap is recognised as a field', fixed[1].kind === 'field', fixed[1].kind);
check('severity "blocking" blocks', fixed[0].blocking === true);
check('severity "optional" does not', fixed[1].blocking === false);
check('the resolution became real steps', fixed[0].steps.length >= 1 && fixed[0].steps[0].length > 0);
check('unknown keys are gone', !('capability' in fixed[0]) && !('severity' in fixed[0]));

// ── 2. Nothing at all ────────────────────────────────────────────────
console.log('\n2. Degenerate input still produces a valid, honest prerequisite');
for (const [label, input] of Object.entries({
  'an empty object': {},
  'null': null,
  'a bare string': 'the org has no email capability',
  'a number': 42,
  'an array': ['a', 'b'],
})) {
  const p = normalizePrerequisite(input, 0);
  const errs = schemaAccepts([p]);
  check(`${label} validates`, errs.length === 0, errs.join('; '));
  check(`${label} still has steps to act on`, p.steps.length > 0);
}

// ── 3. Ids ───────────────────────────────────────────────────────────
console.log('\n3. Ids always match ^PRE-[0-9]{3}$');
for (const [label, id] of Object.entries({
  'a short id': 'PRE-1',
  'a foreign id': 'gap-1',
  'a missing id': undefined,
  'a numeric id': 7,
})) {
  const p = normalizePrerequisite({ id, title: 'x' }, 3);
  check(`${label} is regenerated`, /^PRE-\d{3}$/.test(p.id), p.id);
}
const dupes = normalizePrerequisites([
  { id: 'PRE-001', title: 'first' },
  { id: 'PRE-001', title: 'second' },
]);
check('a duplicate id is renumbered', dupes[0].id !== dupes[1].id, `${dupes[0].id} / ${dupes[1].id}`);

// ── 4. A correct prerequisite is left alone ──────────────────────────
console.log('\n4. Output that was already right is not "corrected"');
const GOOD = {
  id: 'PRE-004',
  kind: 'connector',
  title: 'Salesforce MCP connector',
  why: 'The agent cannot read records without it.',
  steps: ['Connect it on the Connectors page.'],
  assignee: 'integration_owner',
  blocking: true,
  status: 'pending',
  estimatedEffort: 'minutes',
  affects: ['root'],
};
const kept = normalizePrerequisite(GOOD, 3);
check('every field survives unchanged',
  kept.id === 'PRE-004' && kept.kind === 'connector' && kept.assignee === 'integration_owner' &&
  kept.blocking === true && kept.status === 'pending' && kept.estimatedEffort === 'minutes' &&
  kept.affects?.[0] === 'root' && kept.steps[0] === 'Connect it on the Connectors page.');
check('and it validates', schemaAccepts([kept]).length === 0);

// ── 5. Bounds ────────────────────────────────────────────────────────
console.log('\n5. Long values are cut to the lengths the schema allows');
const long = normalizePrerequisite({ title: 'T'.repeat(400), why: 'W'.repeat(900) }, 0);
check('title is capped at 120', long.title.length <= 120, `${long.title.length}`);
check('why is capped at 500', long.why.length <= 500, `${long.why.length}`);
check('and the result validates', schemaAccepts([long]).length === 0);

// ── 6. A blob of prose becomes a checklist ───────────────────────────
console.log('\n6. One paragraph of instructions becomes real steps');
const blob = normalizePrerequisite({
  title: 'Create the field',
  steps: 'Open Setup. Go to Object Manager. Add a currency field named Forecast Amount.',
}, 0);
check('it split into more than one step', blob.steps.length >= 2, JSON.stringify(blob.steps));
check('no step is left with list punctuation', blob.steps.every(s => !/^[-*\d.)\s]+$/.test(s)));

// ── 6b. The platform's own job is never the client's homework ────────
// Live failure: a build told an Apex developer to "design and deploy a Flow
// or invocable Apex class that accepts input from multiple specialists and
// merges their results" — which is the router, shipped and working. A
// client who follows that rebuilds the product they are already using.
console.log('\n6b. Prerequisites never ask the client to rebuild the platform');
const PLATFORM_WORK = [
  { title: 'No orchestration logic for multi-specialist response handling',
    why: 'Assistants cannot combine results from multiple specialists into a coordinated result.',
    owner: 'apex developer' },
  { title: 'Unified AI provider configuration not enforced',
    why: 'There is no automated confirmation that all assistant functions use the same AI provider.',
    owner: 'integration owner' },
  { title: 'Conversation memory is not managed',
    why: 'The agent has no conversation state between turns.', owner: 'admin' },
];
const filtered = normalizePrerequisites(PLATFORM_WORK);
check('every platform-responsibility item is dropped', filtered.length === 0,
  JSON.stringify(filtered.map(p => p.title)));

// The other direction matters more: a real org gap must survive.
const REAL_GAPS = [
  { title: 'Invocable Apex to create a Task', why: 'No Apex action exists to log an activity.', owner: 'apex developer' },
  { title: 'Forecast fields on Opportunity', why: 'The named fields do not exist on the object.', owner: 'admin' },
  { title: 'Salesforce MCP connector', why: 'The connector is not installed, so no tool can run.', owner: 'integration owner' },
  { title: 'Knowledge base of help articles', why: 'No published articles exist to answer from.', owner: 'business owner' },
];
const realKept = normalizePrerequisites(REAL_GAPS);
check('every genuine org gap survives', realKept.length === 4, JSON.stringify(realKept.map(p => p.title)));
check('and ids are renumbered contiguously',
  realKept.map(p => p.id).join(',') === 'PRE-001,PRE-002,PRE-003,PRE-004', realKept.map(p => p.id).join(','));

const mixed = normalizePrerequisites([PLATFORM_WORK[0], REAL_GAPS[0], PLATFORM_WORK[1], REAL_GAPS[1]]);
check('a mixed list keeps only the real gaps, renumbered', 
  mixed.length === 2 && mixed[0].id === 'PRE-001' && mixed[1].id === 'PRE-002',
  JSON.stringify(mixed.map(p => [p.id, p.title])));

// ── 7. Nothing unreachable can ship ──────────────────────────────────
// The failure this prevents: a design with twelve tool nodes and not one
// edge compiled cleanly into an agent that could do nothing, because
// "edges reference real nodes" is passed trivially by having no edges.
console.log('\n7. A node the root cannot reach is repaired, then enforced');
  const orphaned = {
    specVersion: '1.0', name: 'Orphans', department: 'Sales',
    trigger: { type: 'manual' },
    nodes: [
      { id: 'root', type: 'agent', label: 'Root', instructions: 'Be useful.' },
      { id: 't1', type: 'tool', label: 'Query Opportunities', action: { kind: 'mcp', toolName: 'soqlQuery' } },
      { id: 't2', type: 'tool', label: 'Update Account', action: { kind: 'mcp', toolName: 'updateSobjectRecord' } },
      { id: 's1', type: 'subagent', label: 'Pipeline Analyst', description: 'Answers pipeline questions.' },
    ],
    edges: [],
  } as unknown as AgentSpec;

  const before = validateSpecLogic(orphaned);
  check('an unwired design is rejected before repair',
    before.some(e => /no path from the root/.test(e.message)), JSON.stringify(before.map(e => e.message)));
  check('every orphan is named, not just the first',
    before.filter(e => /no path from the root/.test(e.message)).length === 3);

  const notes = attachOrphansToRoot(orphaned);
  check('the repair reports what it wired', notes.length === 3, JSON.stringify(notes));
  check('and it validates afterwards',
    !validateSpecLogic(orphaned).some(e => /no path from the root/.test(e.message)));
  check('a sub-agent is attached as a handoff, not a call',
    orphaned.edges.find(e => e.to === 's1')?.mode === 'handoff');
  check('a tool is attached as static',
    orphaned.edges.find(e => e.to === 't1')?.mode === 'static');

  // A second pass must be a no-op — repairing twice would duplicate edges.
  const again = attachOrphansToRoot(orphaned);
  check('repairing an already-wired graph changes nothing', again.length === 0 && orphaned.edges.length === 3);

  // A tool owned by a sub-agent is reachable THROUGH it, not only directly.
  const nested = {
    specVersion: '1.0', name: 'Nested', department: 'Sales',
    trigger: { type: 'manual' },
    nodes: [
      { id: 'root', type: 'agent', label: 'Root', instructions: 'x' },
      { id: 's1', type: 'subagent', label: 'Analyst', description: 'Answers pipeline questions.' },
      { id: 't1', type: 'tool', label: 'Query', action: { kind: 'mcp', toolName: 'soqlQuery' } },
    ],
    edges: [
      { from: 'root', to: 's1', mode: 'handoff' },
      { from: 's1', to: 't1', mode: 'static' },
    ],
  } as unknown as AgentSpec;
  check('a tool under a sub-agent counts as reachable',
    attachOrphansToRoot(nested).length === 0 && nested.edges.length === 2);

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);

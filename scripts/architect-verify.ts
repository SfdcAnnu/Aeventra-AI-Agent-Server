/**
 * Phase-1 verification for the Agent Architect foundation:
 *   1. architect.agentspec.json — the hardest case — validates against the
 *      schema and the logic checks.
 *   2. The deterministic estimator reproduces the design package's numbers.
 *   3. A known-bad spec is rejected with precise errors (invented tool,
 *      dangling edge, all-false split rationale).
 * No model calls, no org writes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSpec, manifestFromNames, assertActivatable, type AgentSpec } from '../src/architect/spec';
import { estimateSpec } from '../src/architect/estimate';

const specPath = join(process.cwd(), 'architect', 'schemas', 'architect.agentspec.json');
const architect = JSON.parse(readFileSync(specPath, 'utf8')) as AgentSpec;

// 1 — the architect spec validates.
const errors = validateSpec(architect);
if (errors.length > 0) {
  console.error('ARCHITECT SPEC INVALID:');
  for (const e of errors) console.error(`  ${e.path}: ${e.message}`);
  process.exit(1);
}
console.log('1. architect.agentspec.json — VALID (schema + logic)');

// 1b — activation guard: the architect spec is published with no open
// blocking prerequisites, so it must be activatable.
assertActivatable(architect);
console.log('   activation guard — passes (published, nothing blocking)');

// 2 — the estimator.
const est = estimateSpec(architect, { costUsd: 0.6, latencySeconds: 40 });
console.log(
  `2. estimator — ${est.modelCallsPerRun} calls/run, cold $${est.coldUsd.toFixed(4)}, warm $${est.warmUsd.toFixed(4)}, ` +
    `${est.cacheSavingPct}% cache saving, ${est.latencySeconds}s, withinBudget=${est.withinBudget}`,
);
if (est.modelCallsPerRun !== 18) {
  console.error(`   EXPECTED 18 model calls (design package's number) — got ${est.modelCallsPerRun}`);
  process.exit(1);
}
console.log('   matches the design package: 18 model calls per run');

// 3 — a bad spec is rejected precisely.
const bad = JSON.parse(JSON.stringify(architect)) as AgentSpec;
bad.edges.push({ from: 'architect', to: 'ghost_node', mode: 'call' });
(bad.architecture!.splitRationale as Array<{ answer: boolean }>).forEach(q => (q.answer = false));
const badErrors = validateSpec(bad);
const hasDangling = badErrors.some(e => e.message.includes('ghost_node'));
const hasSplit = badErrors.some(e => e.message.includes('forcing question'));
console.log(`3. bad spec rejected — ${badErrors.length} errors (dangling edge: ${hasDangling}, split test: ${hasSplit})`);
if (!hasDangling || !hasSplit) process.exit(1);

// 3b — the manifest stops invented tools.
const manifest = manifestFromNames(['mcp:getObjectSchema']); // save_agent's crud identity is NOT vouched
const manifestErrors = validateSpec(architect, manifest);
const caught = manifestErrors.some(e => e.message.includes('did not discover'));
console.log(`   invented-tool guard — undiscovered crud tool caught: ${caught}`);
if (!caught) process.exit(1);

console.log('\nALL PHASE-1 CHECKS PASS');

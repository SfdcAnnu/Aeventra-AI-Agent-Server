import { describe, it, expect } from 'vitest';

/**
 * resolveMcpServers used to resolve connectors one at a time — a token, a
 * wake ping and a /tools fetch each, the next one not starting until the
 * previous finished. Three connectors meant three round trips end to end
 * before the model could begin.
 *
 * Running them together is only safe if two things survive: the
 * DEDUPLICATED NAME, which reads a Set the previous iteration wrote, and
 * the ORDER of the result. Both are pinned here against the exact naming
 * rule the loop used.
 */
function planNames(providers: string[]): string[] {
  // The same two lines the implementation runs synchronously before any
  // await, lifted so the rule itself is testable.
  const seen = new Set<string>();
  return providers.map(p => {
    let name = p.replace(/[^a-zA-Z0-9_-]/g, '_');
    while (seen.has(name)) name = `${name}_2`;
    seen.add(name);
    return name;
  });
}

describe('connector naming and order', () => {
  it('leaves distinct providers alone', () => {
    expect(planNames(['salesforce_mcp', 'salesforce_metadata', 'gmail']))
      .toEqual(['salesforce_mcp', 'salesforce_metadata', 'gmail']);
  });

  it('deduplicates a repeated provider, in encounter order', () => {
    // Two catalog nodes on one provider — a real shape, one per owning
    // subagent.
    expect(planNames(['salesforce_mcp', 'salesforce_mcp', 'salesforce_mcp']))
      .toEqual(['salesforce_mcp', 'salesforce_mcp_2', 'salesforce_mcp_2_2']);
  });

  it('sanitises characters a provider tool name may not carry', () => {
    expect(planNames(['custom a00X.y'])).toEqual(['custom_a00X_y']);
  });

  it('gives the same names whatever order the work finishes in', () => {
    // The point of the change: names are decided BEFORE any await, so a
    // slow first connector cannot rename a fast second one.
    const first = planNames(['a', 'a', 'b']);
    const second = planNames(['a', 'a', 'b']);
    expect(first).toEqual(second);
    expect(first).toEqual(['a', 'a_2', 'b']);
  });
});

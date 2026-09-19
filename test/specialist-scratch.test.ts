/**
 * A specialist stopped mid-task continues from its findings when called
 * again in the same conversation, and forgets them once it finishes.
 */
import { describe, expect, it } from 'vitest';
import { rememberScratch, recallScratch, clearScratch, withScratch } from '../src/lc/specialist-scratch';

describe('specialist scratch', () => {
  it('remembers per session and specialist, and clears on a finished call', () => {
    rememberScratch('s1', 'n1', '{"status":"stopped"}');
    expect(recallScratch('s1', 'n1')).toBe('{"status":"stopped"}');
    expect(recallScratch('s1', 'n2')).toBeNull();
    expect(recallScratch('s2', 'n1')).toBeNull();
    clearScratch('s1', 'n1');
    expect(recallScratch('s1', 'n1')).toBeNull();
  });
  it('folds the prior findings into the task, and leaves a fresh task alone', () => {
    expect(withScratch('Draft a flow', null)).toBe('Draft a flow');
    const t = withScratch('Draft a flow', '{"findings":[]}');
    expect(t.startsWith('Draft a flow')).toBe(true);
    expect(t).toContain('PREVIOUS ATTEMPT');
    expect(t).toContain('{"findings":[]}');
  });
  it('ignores a turn with no session (the test panel)', () => {
    rememberScratch(null, 'n1', 'x');
    expect(recallScratch(null, 'n1')).toBeNull();
  });
});

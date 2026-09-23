import { describe, it, expect } from 'vitest';
import { recoverStructured } from '../src/architect/specialists';

/**
 * On the Responses API, withStructuredOutput handed back the content-block
 * array coerced into an object instead of the parsed answer. The Evaluator
 * read "unclear" where the text said "fail"; the Matcher read undefined
 * lists as full coverage. The real answer is the JSON inside the box.
 */
const boxed = { '0': { annotations: [], type: 'text', text: '{"verdict":"fail","failures":[{"rootCause":"no script"}],"fixes":[],"uncovered":["Create Lead with Status = New"]}' } };
const rawContent = [{ type: 'text', text: boxed['0'].text }];

describe('recoverStructured', () => {
  it('unboxes the content-block object into the answer it carries', () => {
    const r = recoverStructured(boxed, rawContent, 'Evaluator') as { verdict: string; uncovered: string[] };
    expect(r.verdict).toBe('fail');
    expect(r.uncovered).toEqual(['Create Lead with Status = New']);
  });
  it('reads the box itself when no raw content came back', () => {
    const r = recoverStructured(boxed, undefined, 'Evaluator') as { verdict: string };
    expect(r.verdict).toBe('fail');
  });
  it('leaves a real answer alone', () => {
    const real = { verdict: 'pass', failures: [], fixes: [] };
    expect(recoverStructured(real, rawContent, 'Evaluator')).toBe(real);
    expect(recoverStructured(null, rawContent, 'Evaluator')).toBeNull();
    expect(recoverStructured([1, 2], rawContent, 'Evaluator')).toEqual([1, 2]);
  });
  it('rejects a box whose text is not JSON, by name', () => {
    const prose = { '0': { type: 'text', text: 'I cannot judge this.' } };
    expect(() => recoverStructured(prose, undefined, 'Evaluator')).toThrow(/'Evaluator' did not return a JSON object/);
  });
});

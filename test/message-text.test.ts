import { describe, it, expect } from 'vitest';
import { messageText } from '../src/lc/message-text';

/**
 * The bug this prevents cost $1.72 in one build.
 *
 * design_flow asks for a raw JSON AgentSpec. On Chat Completions the reply
 * arrived as a string and parsed fine. Routed to the Responses API it
 * arrived as an array of blocks, the caller reached for
 * JSON.stringify(content), and the parser was handed the envelope instead
 * of the spec — so a perfectly good design "never came back as an
 * AgentSpec", three attempts running.
 */
describe('messageText', () => {
  it('passes a plain string through, as Chat Completions sends it', () => {
    expect(messageText('{"nodes":[],"edges":[]}')).toBe('{"nodes":[],"edges":[]}');
  });

  it('takes the reply out of Responses API blocks', () => {
    const content = [
      { type: 'reasoning', summary: 'the user wants a lead flow' },
      { type: 'output_text', text: '{"nodes":[{"id":"root"}],"edges":[]}' },
    ];
    expect(messageText(content)).toBe('{"nodes":[{"id":"root"}],"edges":[]}');
  });

  it('never returns the envelope, which is what broke the build', () => {
    const content = [{ type: 'text', text: '{"specVersion":"1.0"}' }];
    const out = messageText(content);
    expect(out).not.toContain('"type"');
    expect(JSON.parse(out)).toEqual({ specVersion: '1.0' });
  });

  it('drops reasoning even when it is the only block', () => {
    expect(messageText([{ type: 'reasoning', summary: 'thinking out loud' }])).toBe('');
  });

  it('joins several text blocks in order', () => {
    const content = [
      { type: 'text', text: '{"a":1,' },
      { type: 'reasoning', summary: 'ignore me' },
      { type: 'text', text: '"b":2}' },
    ];
    expect(JSON.parse(messageText(content))).toEqual({ a: 1, b: 2 });
  });

  it('survives anything unexpected rather than throwing', () => {
    expect(messageText(null)).toBe('');
    expect(messageText(undefined)).toBe('');
    expect(messageText(42)).toBe('');
    expect(messageText([null, undefined, 7])).toBe('');
    expect(messageText([{ type: 'text' }])).toBe('');
  });
});

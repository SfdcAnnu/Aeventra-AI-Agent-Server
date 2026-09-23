import { describe, it, expect } from 'vitest';
import { buildSystemPromptParts } from '../src/chat/adapters/shared';

/**
 * THE MODEL IS TOLD THE SENDER'S PHONE, OR THAT THERE IS NONE.
 *
 * A live agent, told by its prompt to "identify the sender's WhatsApp
 * phone" on a channel that had none (the Testing tab), guessed one (+91),
 * searched a name in phone fields, and saved the NAME into Lead.Phone.
 * The tool node's {{inbound_message.sender_phone}} mapping is never read
 * at runtime; this block is the only way the number -- or its absence --
 * reaches the model.
 */
const agent = { apiName: 'whatsapp_lead_intake_qualifier', name: 'WhatsApp', knowledgeBase: null, nodes: [] } as never;
const aiNode = { id: 'ai', nodeType: 'ai', nodeSubType: 'gpt4', config: { systemPrompt: 'You are a lead intake agent.' } } as never;
// KB and record fetches are bypassed through the prefetch seam: this
// test is about the sentence, not the reads.
const noFetch = { kbBlock: Promise.resolve(null), recordBlock: undefined };

const build = (ctx: Record<string, unknown>) =>
  buildSystemPromptParts(agent, aiNode, ctx as never, 'hello', null, null, null, noFetch);

describe('sender phone in the prompt', () => {
  it('states the number and the channel when the caller supplied them', async () => {
    const parts = await build({ orgId: 'org', userId: 'u', senderPhone: '+91 98765 43210', channel: 'whatsapp' });
    expect(parts.volatile).toContain('CHANNEL: whatsapp');
    expect(parts.volatile).toContain('SENDER PHONE: +91 98765 43210');
    expect(parts.volatile).toContain('do not ask the customer for it');
  });

  it('states plainly that there is NO number, so the model does not guess one', async () => {
    const parts = await build({ orgId: 'org', userId: 'u', channel: 'test' });
    expect(parts.volatile).toContain('CHANNEL: test');
    expect(parts.volatile).toContain('No sender phone number is available');
    expect(parts.volatile).toContain('never guess a number');
    expect(parts.volatile).not.toContain('SENDER PHONE:');
  });

  it('treats an empty string as no number', async () => {
    const parts = await build({ orgId: 'org', userId: 'u', senderPhone: '' });
    expect(parts.volatile).toContain('No sender phone number is available');
  });

  it('keeps the fact out of the STABLE block, so the cached prefix is unchanged', async () => {
    const withPhone = await build({ orgId: 'org', userId: 'u', senderPhone: '+91 1' });
    const without = await build({ orgId: 'org', userId: 'u' });
    expect(withPhone.stable).toBe(without.stable);
  });
});

/**
 * stream-call — one model call, streamed to a waiting reader when there is
 * someone to deliver it to, and an ordinary invoke when there is not.
 *
 * THREE RULES HOLD THIS TOGETHER.
 *
 * 1. THE FINAL FRAME IS THE TRUTH. Whatever is streamed is an accelerant,
 *    never the record. The turn result always carries the complete reply,
 *    and the browser renders that over anything it showed. So every failure
 *    path here can simply stop and reset: a dropped delta, a mid-stream
 *    error, a reader that cannot keep up. Nothing is lost, because the
 *    authoritative copy is still coming.
 *
 * 2. NOTHING IS SHOWN FROM A PASS THAT TURNS OUT TO BE A TOOL CALL. The
 *    router loops: a response carrying tool calls is not the answer, and a
 *    later pass will replace it. Text is held back until enough of it has
 *    arrived with no tool call in sight, and if a tool call appears after
 *    the flush the reader is told to discard what it saw. Providers decide
 *    to call a tool before they write prose, so the hold almost always
 *    settles it.
 *
 * 3. THE AGGREGATE BECOMES A REAL AIMessage. AIMessageChunk extends
 *    BaseMessageChunk, NOT AIMessage, and this runtime tests `instanceof
 *    AIMessage` in the places that count tokens (sumUsage, turn-budget's
 *    noteUsage) and read the reply (lastAssistantText). Returning a chunk
 *    would report a streamed turn as costing zero tokens, and the org's
 *    usage guardrails add those numbers up. The conversion below is not a
 *    tidiness measure.
 */
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { Runnable, RunnableConfig } from '@langchain/core/runnables';
import { concat } from '@langchain/core/utils/stream';
import { logger } from '../logger';
import { messageText } from './message-text';

/** Characters of text to hold before showing any, while watching for a
 *  tool call. Small enough to feel immediate, large enough that a response
 *  which opens with a tool call never leaks a word. */
const HOLD_CHARS = Number(process.env.STREAM_HOLD_CHARS) || 24;

/** Server-side kill switch. Set STREAM_TEXT=off to fall back to plain
 *  invokes everywhere without deploying code. */
const TEXT_ENABLED = (process.env.STREAM_TEXT ?? 'on').toLowerCase() !== 'off';

export interface StreamCallOptions {
  /** Visible text, as it is produced. Absent means invoke as before. */
  onDelta?: (text: string) => void;
  /** Discard everything shown for this call. Sent when the pass turns out
   *  to carry tool calls, or when streaming failed and fell back. */
  onReset?: () => void;
  config?: RunnableConfig;
}

type ModelRunnable = Runnable<BaseMessage[], AIMessage | AIMessageChunk>;

/** Only real output text. Reasoning and thinking blocks are billed but are
 *  not the reply, and must never reach a reader as though they were. */
const visibleText = (chunk: AIMessageChunk): string => messageText(chunk.content);

/** See rule 3 in the module doc. */
function toAIMessage(agg: AIMessageChunk | undefined): AIMessage {
  if (!agg) return new AIMessage({ content: '' });
  return new AIMessage({
    id: agg.id,
    content: agg.content,
    tool_calls: agg.tool_calls ?? [],
    invalid_tool_calls: agg.invalid_tool_calls ?? [],
    additional_kwargs: agg.additional_kwargs,
    response_metadata: agg.response_metadata,
    usage_metadata: agg.usage_metadata,
    ...(agg.name ? { name: agg.name } : {}),
  });
}

export async function callModel(
  model: ModelRunnable,
  messages: BaseMessage[],
  options: StreamCallOptions = {},
): Promise<AIMessage> {
  const { onDelta, onReset, config } = options;
  if (!onDelta || !TEXT_ENABLED) {
    return (await model.invoke(messages, config)) as AIMessage;
  }

  let aggregate: AIMessageChunk | undefined;
  let held = '';
  let flushed = false;
  let sawToolCall = false;

  try {
    for await (const chunk of await model.stream(messages, config)) {
      const part = chunk instanceof AIMessageChunk ? chunk : new AIMessageChunk({ content: chunk.content });
      aggregate = aggregate === undefined ? part : concat(aggregate, part);

      if (!sawToolCall) {
        const calling = (part.tool_call_chunks?.length ?? 0) > 0 || (aggregate.tool_calls?.length ?? 0) > 0;
        if (calling) {
          sawToolCall = true;
          // Rule 2: this pass is not the answer. Anything already shown for
          // it has to go, and nothing further is shown.
          if (flushed) onReset?.();
          held = '';
          continue;
        }
        const text = visibleText(part);
        if (!text) continue;
        if (flushed) { onDelta(text); continue; }
        held += text;
        if (held.length >= HOLD_CHARS) { flushed = true; onDelta(held); held = ''; }
      }
    }
  } catch (err) {
    // Rule 1: reliability is never traded for speed. A provider that cannot
    // stream still has to answer, so fall back to the call that has always
    // worked and tell the reader to drop the fragment it saw.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'lc_stream_failed_falling_back_to_invoke',
    );
    if (flushed) onReset?.();
    return (await model.invoke(messages, config)) as AIMessage;
  }

  // A reply shorter than the hold window never reached the flush.
  if (!sawToolCall && !flushed && held) onDelta(held);

  const message = toAIMessage(aggregate);
  // The one failure that must never be silent: a streamed call whose usage
  // never arrived would be billed by the provider and counted as free here.
  if (!message.usage_metadata) {
    logger.error({ hasToolCalls: (message.tool_calls ?? []).length > 0 }, 'lc_stream_usage_missing');
  }
  return message;
}

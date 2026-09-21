/**
 * message-text — the words a model actually said, whichever endpoint said
 * them.
 *
 * THE SHAPE IS NOT THE SAME ON BOTH ENDPOINTS. Chat Completions puts the
 * reply in `content` as a plain string. The Responses API puts it in
 * `content` as an ARRAY of blocks — reasoning, refusals and output text
 * side by side — and the shape changes under you the moment a model is
 * routed from one to the other.
 *
 * Code that assumed a string used to reach for JSON.stringify(content) on
 * the array, which produces a string of the whole envelope:
 *
 *   [{"type":"reasoning",…},{"type":"text","text":"{\"nodes\":[…]}"}]
 *
 * A parser then finds the first `{` and the last `}` in THAT and returns
 * the envelope instead of the answer. Live cost of the mistake: an
 * Architect build that spent $1.72 and failed with "the design never came
 * back as an AgentSpec", three attempts running, because the spec was
 * there all along and nobody unwrapped it.
 *
 * Reasoning blocks are dropped deliberately. They are billed, they are not
 * the answer, and a reader must never be shown one as though it were.
 */

interface ContentBlock {
  type?: string;
  text?: string;
}

/** Only the blocks that carry the reply. */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (typeof block === 'string') { out += block; continue; }
    const { type, text } = (block ?? {}) as ContentBlock;
    if (type === 'text' || type === 'text_delta' || type === 'output_text') out += String(text ?? '');
  }
  return out;
}

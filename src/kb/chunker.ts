/**
 * Heading-aware text chunker. No tokenizer dependency — approximates
 * tokens as ~4 chars (close enough for chunk sizing; embeddings APIs
 * re-tokenize on their own end regardless).
 */
const CHARS_PER_TOKEN = 4;
const TARGET_TOKENS = 800;
const OVERLAP_TOKENS = 150;
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;

/**
 * Splits `text` into overlapping chunks, preferring to break on heading
 * lines (markdown `#`/`##`/...) or paragraph boundaries over mid-sentence.
 */
export function chunkText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  if (normalized.length <= TARGET_CHARS) return [normalized];

  // Split into paragraphs, keeping heading lines attached to the
  // paragraph that follows them so a heading never ends up alone at the
  // tail of one chunk with its content pushed into the next.
  const paragraphs = normalized.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);

  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= TARGET_CHARS) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      // Carry the tail of the previous chunk forward as overlap context.
      const tail = current.slice(-OVERLAP_CHARS);
      current = tail ? `${tail}\n\n${para}` : para;
    } else {
      // A single paragraph longer than the target — hard-split it.
      chunks.push(...hardSplit(para));
      current = '';
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

function hardSplit(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + TARGET_CHARS, text.length);
    out.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - OVERLAP_CHARS;
  }
  return out;
}

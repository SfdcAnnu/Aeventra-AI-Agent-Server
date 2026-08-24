/**
 * Turns an uploaded file (as base64) into plain text for the KB indexer.
 *
 * PDFs are the one binary format that needs real parsing — naively decoding
 * PDF bytes as UTF-8 produces binary noise, not the document's text. Plain
 * text formats (.txt/.md/...) are already readable once base64-decoded, so
 * they pass straight through.
 */
import pdfParse from 'pdf-parse';

const PDF_EXTENSION_RE = /\.pdf$/i;

export async function extractTextFromUpload(fileBase64: string, fileName: string | null): Promise<string> {
  const buffer = Buffer.from(fileBase64, 'base64');
  const looksLikePdf = (fileName && PDF_EXTENSION_RE.test(fileName)) || isPdfMagicBytes(buffer);

  if (looksLikePdf) {
    try {
      const parsed = await pdfParse(buffer);
      return parsed.text ?? '';
    } catch (err) {
      throw new Error(`Could not read this PDF (${err instanceof Error ? err.message : 'unknown error'}) — it may be scanned/image-only, password-protected, or corrupted.`);
    }
  }

  return buffer.toString('utf8');
}

/** %PDF- magic bytes — a fallback for when fileName wasn't passed through. */
function isPdfMagicBytes(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer.subarray(0, 5).toString('utf8') === '%PDF-';
}

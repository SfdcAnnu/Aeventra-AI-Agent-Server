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

  const unsupported = binaryFormatOf(buffer, fileName);
  if (unsupported) {
    // Decoding a binary as UTF-8 yields mojibake that chunks and embeds
    // perfectly happily — silent garbage in the knowledge base, which is
    // worse than a refusal because retrieval then returns nonsense that
    // looks like a real answer.
    throw new Error(
      `${unsupported} files can't be read yet — the knowledge base understands PDF and plain text ` +
        '(.txt, .md, .csv, .json). Save this as a PDF, or paste the text directly.',
    );
  }

  return buffer.toString('utf8');
}

/** Name the binary format when it is one we cannot read, else null. */
function binaryFormatOf(buffer: Buffer, fileName: string | null): string | null {
  const byName = /\.(docx?|xlsx?|pptx?|rtf|odt|ods|odp|zip|png|jpe?g|gif|webp|bmp|tiff?|mp[34]|wav|mov|avi)$/i.exec(
    fileName ?? '',
  );
  if (byName) return byName[1].toLowerCase().startsWith('doc') ? 'Word' : `.${byName[1].toLowerCase()}`;

  if (buffer.length < 4) return null;
  const head = buffer.subarray(0, 4);
  // PK.. — every Office Open XML file (docx/xlsx/pptx) and any other zip.
  if (head[0] === 0x50 && head[1] === 0x4b) return 'Word, Excel and PowerPoint';
  // D0 CF 11 E0 — legacy OLE compound file (.doc/.xls/.ppt).
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return 'Legacy Office';
  if (head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG') return 'Image';
  if (head[0] === 0xff && head[1] === 0xd8) return 'Image';
  return null;
}

/** %PDF- magic bytes — a fallback for when fileName wasn't passed through. */
function isPdfMagicBytes(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer.subarray(0, 5).toString('utf8') === '%PDF-';
}

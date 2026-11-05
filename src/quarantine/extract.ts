// Implements: §8.2 step 1 / step 3 text extraction — `application/pdf` via pdf-parse, `text/html` via html-to-text,
// text types UTF-8 decoded (§5 stack: pdf-parse, html-to-text). Extracted text is untrusted content: it only ever
// goes to the Q-LLM (§3.2, §16.1) and is never logged or stored (§8.2 step 6).
// Owner: Lane B.

import { convert } from 'html-to-text';
import { PDFParse } from 'pdf-parse';

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

export function htmlToText(html: string): string {
  return convert(html, { wordwrap: false });
}

export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

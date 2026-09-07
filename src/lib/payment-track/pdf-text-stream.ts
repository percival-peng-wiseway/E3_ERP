// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { ProposalPdfReadError } from "./pdf-read-errors.ts";

// PDF.js getTextContent() uses ReadableStream[Symbol.asyncIterator], which is
// absent in older Safari even in PDF.js's legacy build (mozilla/pdf.js#20973).
// Consume its public text stream with getReader instead. No global polyfills
// or PDF.js internals are needed, and text positions/order are preserved.
export async function readProposalTextItems<T>(stream: ReadableStream<{ items: T[] }>): Promise<T[]> {
  const reader = stream.getReader();
  const items: T[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return items;
      if (items.length + value.items.length > 50_000) {
        throw new ProposalPdfReadError("PDF_TEXT_LIMIT");
      }
      for (const item of value.items) items.push(item);
    }
  } catch (error) {
    // Do not forward document-derived exceptions as cancellation metadata.
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export type ProposalPdfReadCode =
  | "PDF_RUNTIME_LOAD" | "PDF_WORKER_INIT" | "PDF_PASSWORD"
  | "PDF_INVALID" | "PDF_PAGE_LIMIT" | "PDF_TEXT_LIMIT"
  | "PDF_BROWSER_UNSUPPORTED" | "PDF_READ_FAILED";

const messages: Record<ProposalPdfReadCode, string> = {
  PDF_RUNTIME_LOAD: "The PDF reader could not finish loading. Refresh this page and choose the PDF again.",
  PDF_WORKER_INIT: "The PDF reader could not start. Refresh this page and choose the PDF again.",
  PDF_PASSWORD: "This PDF is password protected. Upload an unlocked copy.",
  PDF_INVALID: "This PDF is incomplete or damaged. Download the original PDF again and retry.",
  PDF_PAGE_LIMIT: "This proposal exceeds the supported limit of 40 pages.",
  PDF_TEXT_LIMIT: "This PDF contains more text than the proposal reader can safely process.",
  PDF_BROWSER_UNSUPPORTED: "This browser cannot run the PDF reader. Update your browser and retry.",
  PDF_READ_FAILED: "The PDF reader failed while reading this file. Refresh the page and retry; if it persists, report the error code below.",
};

export class ProposalPdfReadError extends Error {
  readonly code: ProposalPdfReadCode;
  constructor(code: ProposalPdfReadCode) {
    super(`${messages[code]} [${code}]`);
    this.code = code;
    this.name = "ProposalPdfReadError";
  }
}

// Inspect an exception only to classify it. Never expose its original message,
// which may contain document text, URLs or other private information.
export function classifyProposalPdfReadError(error: unknown): ProposalPdfReadError {
  if (error instanceof ProposalPdfReadError) return error;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (name === "PasswordException") return new ProposalPdfReadError("PDF_PASSWORD");
  if (name === "InvalidPDFException" || name === "MissingPDFException") return new ProposalPdfReadError("PDF_INVALID");
  if (/fake worker|worker.*(?:destroyed|failed)|api version.*worker version/i.test(message)) return new ProposalPdfReadError("PDF_WORKER_INIT");
  if (/chunk.*(?:load|fail)|load(?:ing)?.*chunk|fetch.*dynamically imported|importing a module/i.test(message)) return new ProposalPdfReadError("PDF_RUNTIME_LOAD");
  if (/structuredClone|Promise\.withResolvers|DOMMatrix|\.toHex|\.fromBase64|\.toBase64/.test(message)) return new ProposalPdfReadError("PDF_BROWSER_UNSUPPORTED");
  return new ProposalPdfReadError("PDF_READ_FAILED");
}

export function retryableProposalPdfRead(error: ProposalPdfReadError) {
  return error.code === "PDF_RUNTIME_LOAD" || error.code === "PDF_WORKER_INIT";
}

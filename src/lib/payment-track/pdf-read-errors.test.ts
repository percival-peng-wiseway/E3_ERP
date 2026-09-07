import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { classifyProposalPdfReadError, ProposalPdfReadError, retryableProposalPdfRead } from "./pdf-read-errors.ts";

test("classifies PDF read failures without exposing original error details", () => {
  const cases = [
    ["Error", "Failed to load chunk /private-document?token=secret", "PDF_RUNTIME_LOAD"],
    ["Error", "Failed to fetch dynamically imported module /private-document", "PDF_RUNTIME_LOAD"],
    ["Error", "Setting up fake worker failed: /private-document", "PDF_WORKER_INIT"],
    ["Error", 'The API version "6" does not match the Worker version "5"', "PDF_WORKER_INIT"],
    ["PasswordException", "private-document", "PDF_PASSWORD"],
    ["InvalidPDFException", "private-document", "PDF_INVALID"],
    ["TypeError", "Promise.withResolvers is not a function private-document", "PDF_BROWSER_UNSUPPORTED"],
    ["TypeError", "data.toHex is not a function private-document", "PDF_BROWSER_UNSUPPORTED"],
    ["Error", "private-document contents and token=secret", "PDF_READ_FAILED"],
  ] as const;
  for (const [name, message, code] of cases) {
    const raw = new Error(message);
    raw.name = name;
    const classified = classifyProposalPdfReadError(raw);
    assert.equal(classified.code, code);
    assert.match(classified.message, new RegExp(`\\[${code}\\]`));
    assert.doesNotMatch(classified.message, /private-document|secret/);
    assert.equal("cause" in classified, false);
  }
});

test("retries only runtime and worker failures, not invalid or oversized documents", () => {
  for (const code of ["PDF_RUNTIME_LOAD", "PDF_WORKER_INIT"] as const) {
    assert.equal(retryableProposalPdfRead(new ProposalPdfReadError(code)), true);
  }
  for (const code of ["PDF_PASSWORD", "PDF_INVALID", "PDF_PAGE_LIMIT", "PDF_TEXT_LIMIT", "PDF_BROWSER_UNSUPPORTED", "PDF_READ_FAILED"] as const) {
    const error = new ProposalPdfReadError(code);
    assert.equal(classifyProposalPdfReadError(error), error);
    assert.equal(retryableProposalPdfRead(error), false);
  }
  assert.equal(classifyProposalPdfReadError(null).code, "PDF_READ_FAILED");
  assert.equal(classifyProposalPdfReadError("private payload").code, "PDF_READ_FAILED");
});

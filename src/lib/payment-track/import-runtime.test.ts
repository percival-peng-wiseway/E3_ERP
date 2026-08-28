import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectRoot = process.cwd();

test("proposal import parses PDF in the browser instead of the Worker route", async () => {
  const [routeSource, workspaceSource] = await Promise.all([
    readFile(path.join(projectRoot, "src/app/api/payment-track/import/route.ts"), "utf8"),
    readFile(path.join(projectRoot, "src/components/payment-track-workspace.tsx"), "utf8"),
  ]);

  assert.doesNotMatch(routeSource, /payment-track\/pdf-parser|parsePaymentAgreementPdf/);
  assert.match(routeSource, /parsedAgreement/);
  assert.match(workspaceSource, /await import\("@\/lib\/payment-track\/pdf-parser"\)/);
  assert.match(workspaceSource, /body\.set\("parsedAgreement"/);
});

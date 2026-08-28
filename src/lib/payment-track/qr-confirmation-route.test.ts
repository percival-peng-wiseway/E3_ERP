import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const routePath = path.resolve(
  process.cwd(),
  "src/app/api/payment-track/[id]/rebate-qr-code/route.ts",
);

test("QR confirmation route is session-bound same-origin JSON and cannot upload files", async () => {
  const source = await readFile(routePath, "utf8");

  assert.match(source, /getErpSession\(request\)/);
  assert.match(source, /session\.user\.displayName/);
  assert.match(source, /isSameOriginRequest\(request\)/);
  assert.match(source, /isAuthorizedMutationRequest\(request\)/);
  assert.match(source, /isAuthorizedActorRequest\(request, "pm"\)/);
  assert.match(source, /parsePaymentTrackQrConfirmation\(body\)/);
  assert.match(source, /readPaymentTrackJson\(request, MAX_JSON_SIZE\)/);
  assert.match(source, /contentType !== "application\/json"/);
  assert.doesNotMatch(source, /readPaymentTrackForm|\.formData\(|instanceof File|storedUpload/);
});

test("QR confirmation route rejects non-browser bearer-only requests", async () => {
  const source = await readFile(routePath, "utf8");
  assert.match(source, /request\.headers\.has\("origin"\) \|\| request\.headers\.has\("sec-fetch-site"\)/);
  assert.match(source, /if \(!isBrowserRequest \|\| !isSameOriginRequest\(request\)\)/);
});

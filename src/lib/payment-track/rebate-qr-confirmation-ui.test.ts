import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const componentSource = await readFile(
  new URL("../../components/payment-track-workspace.tsx", import.meta.url),
  "utf8",
);
const styleSource = await readFile(
  new URL("../../components/payment-track-workspace.module.css", import.meta.url),
  "utf8",
);

test("rebate QR readiness uses a confirmation action without requiring a file", () => {
  assert.match(componentSource, /function RebateQrConfirmationAction/);
  assert.match(componentSource, /Confirm QR code received/);
  assert.match(componentSource, /Confirming…/);
  assert.match(componentSource, /aria-busy=\{busy\}/);
  assert.match(componentSource, /disabled=\{busy\}/);

  assert.doesNotMatch(componentSource, /rebateQrFile/);
  assert.doesNotMatch(componentSource, /RequiredFileAction/);
  assert.doesNotMatch(componentSource, /Upload rebate QR code/);
  assert.doesNotMatch(componentSource, /Upload QR code/);
  assert.doesNotMatch(componentSource, /Choose QR code file/);
  assert.match(
    componentSource,
    /isPaymentTrackWaitingForRebateQr\(project\)\s*&&\s*!hasActiveWorkSchedule\(project\)/,
    "a fully scheduled legacy project must remain actionable",
  );
});

test("rebate QR confirmation calls the dedicated endpoint with no upload payload", () => {
  assert.match(
    componentSource,
    /fetch\(`\/api\/payment-track\/\$\{selected\.id\}\/rebate-qr-code`,\s*\{[\s\S]*?method: "POST",[\s\S]*?"Content-Type": "application\/json"[\s\S]*?JSON\.stringify\(\{ actorRole: "pm", expectedUpdatedAt: selected\.updatedAt \}\)/,
  );
  assert.doesNotMatch(componentSource, /body\.set\("qrCode"/);
  assert.match(componentSource, /Solar Rebate QR code received\. Work is now Unscheduled\./);
});

test("non-PM roles wait for PM while Administrators retain the PM proxy", () => {
  assert.match(
    componentSource,
    /Waiting for the Project Manager to confirm the Solar Rebate QR code was received\./,
  );
  assert.match(componentSource, /allowContinue=\{authenticatedRole === "admin"\}/);
  assert.match(componentSource, /buttonLabel="Continue as Project Manager"/);
});

test("the QR confirmation card stays compact", () => {
  assert.match(styleSource, /\.rebateQrConfirmationPanel\s*\{[^}]*align-items:\s*center;/);
  assert.match(styleSource, /\.rebateQrConfirmationPanel > \.primaryButton\s*\{[^}]*min-width:\s*220px;/);
  assert.doesNotMatch(styleSource, /\.requiredFileGrid/);
});

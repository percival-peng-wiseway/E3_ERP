import assert from "node:assert/strict";
import { test } from "node:test";

const qrConfirmationModule = "./qr-confirmation.ts";
const { parsePaymentTrackQrConfirmation } = await import(qrConfirmationModule) as typeof import("./qr-confirmation");

const expectedUpdatedAt = "2026-08-28T01:02:03.004Z";

test("QR receipt confirmation accepts only the exact PM JSON contract", () => {
  assert.deepEqual(parsePaymentTrackQrConfirmation({
    actorRole: "pm",
    expectedUpdatedAt,
  }), {
    actorRole: "pm",
    expectedUpdatedAt,
  });
});

test("QR receipt confirmation rejects Sales, missing or malformed versions, and upload fields", () => {
  assert.equal(parsePaymentTrackQrConfirmation({
    actorRole: "sales",
    expectedUpdatedAt,
  }), null);
  assert.equal(parsePaymentTrackQrConfirmation({ actorRole: "pm" }), null);
  assert.equal(parsePaymentTrackQrConfirmation({
    actorRole: "pm",
    expectedUpdatedAt: "28/08/2026",
  }), null);
  assert.equal(parsePaymentTrackQrConfirmation({
    actorRole: "pm",
    expectedUpdatedAt,
    qrCode: "synthetic-upload",
  }), null);
});

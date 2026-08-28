import assert from "node:assert/strict";
import test from "node:test";

const modulePath = "./body-reader.ts";
const {
  PaymentTrackRequestBodyTooLarge,
  readPaymentTrackForm,
} = await import(modulePath) as typeof import("./body-reader");

function multipartRequest(value: string) {
  const boundary = "payment-track-test-boundary";
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="value"',
    "",
    value,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return {
    request: new Request("https://erp.example/api/payment-track/import", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    }),
    size: new TextEncoder().encode(body).byteLength,
  };
}

test("bounded multipart parsing accepts a body at the real streamed size", async () => {
  const { request, size } = multipartRequest("proposal");
  const form = await readPaymentTrackForm(request, size);
  assert.equal(form.get("value"), "proposal");
});

test("bounded multipart parsing rejects an oversized stream without relying on Content-Length", async () => {
  const { request, size } = multipartRequest("x".repeat(4_096));
  assert.equal(request.headers.get("content-length"), null);
  await assert.rejects(
    readPaymentTrackForm(request, size - 1),
    (error: unknown) => error instanceof PaymentTrackRequestBodyTooLarge,
  );
});

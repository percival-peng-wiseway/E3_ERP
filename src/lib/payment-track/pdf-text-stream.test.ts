import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { readProposalTextItems } from "./pdf-text-stream.ts";

test("reads all text chunks in order without stream async iteration and releases the lock", async () => {
  const first = { str: "First", transform: [1, 0, 0, 1, 72, 100] };
  const second = { str: "Second", transform: [1, 0, 0, 1, 80, 100] };
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue({ items: [first] });
      controller.enqueue({ items: [] });
      controller.enqueue({ items: [second] });
      controller.close();
    },
  });
  Object.defineProperty(stream, Symbol.asyncIterator, { value: undefined });
  assert.deepEqual(await readProposalTextItems(stream), [first, second]);
  assert.equal(stream.locked, false);
});

test("enforces the item limit across chunks and cancels without exposing error metadata", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue({ items: Array(50_000).fill("text") });
      controller.enqueue({ items: ["one too many"] });
    },
    cancel(reason) {
      cancelled = true;
      assert.equal(reason, undefined);
      throw new Error("cleanup failure must not replace the limit error");
    },
  });
  await assert.rejects(readProposalTextItems(stream), { code: "PDF_TEXT_LIMIT" });
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("releases the reader and preserves a text stream failure", async () => {
  const failure = new Error("test stream failure");
  const stream = new ReadableStream<{ items: string[] }>({
    pull(controller) { controller.error(failure); },
  });
  await assert.rejects(readProposalTextItems(stream), (error: unknown) => error === failure);
  assert.equal(stream.locked, false);
});

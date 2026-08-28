import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error -- Node ESM tests require the explicit extension.
import { parseKnowledgeCitationSelection } from "./knowledge-citation-selection.ts";

test("knowledge answers require a bounded final citation selection", () => {
  assert.deepEqual(
    parseKnowledgeCitationSelection("Use 216–253V.\n[[KB_CITATIONS:knowledge/doc/g2/00001, knowledge/doc/g2/00002]]"),
    { answer: "Use 216–253V.", chunkIds: ["knowledge/doc/g2/00001", "knowledge/doc/g2/00002"] },
  );
  assert.equal(parseKnowledgeCitationSelection("Uncited model answer"), null);
  assert.equal(parseKnowledgeCitationSelection("Answer\n[[KB_CITATIONS:../../forged id]]"), null);
});

import assert from "node:assert/strict";
import test from "node:test";

const modulePath = "./knowledge-readiness.ts";
const { knowledgeReadinessPresentation, readAgentKnowledgeReadiness } = await import(modulePath) as typeof import("./knowledge-readiness");

test("Home Agent knowledge readiness keeps an empty index separate from an unavailable source", () => {
  const empty = readAgentKnowledgeReadiness({
    data: {
      sources: {
        knowledge_base: {
          status: "empty",
          details: { readyDocuments: 0, activeChunks: 0 },
        },
      },
    },
  });
  assert.equal(empty.status, "empty");
  assert.equal(knowledgeReadinessPresentation(empty).label, "Knowledge empty");

  const unavailable = readAgentKnowledgeReadiness({
    data: { sources: { knowledge_base: { status: "unavailable" } } },
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(knowledgeReadinessPresentation(unavailable).label, "Knowledge unavailable");
});

test("Home Agent knowledge readiness displays ready document and active chunk counts", () => {
  const ready = readAgentKnowledgeReadiness({
    data: {
      sources: {
        knowledge_base: {
          status: "available",
          details: { readyDocuments: 3, activeChunks: 42 },
        },
      },
    },
  });
  assert.deepEqual(ready, { status: "ready", readyDocuments: 3, activeChunks: 42 });
  assert.deepEqual(knowledgeReadinessPresentation(ready), {
    label: "Knowledge ready 3",
    title: "3 ready knowledge documents · 42 active chunks",
    tone: "ready",
  });
});

test("Home Agent knowledge readiness fails closed on malformed health metadata", () => {
  const malformed = readAgentKnowledgeReadiness({
    data: {
      sources: {
        knowledge_base: {
          status: "available",
          details: { readyDocuments: 1, activeChunks: -5 },
        },
      },
    },
  });
  assert.equal(malformed.status, "unavailable");
});

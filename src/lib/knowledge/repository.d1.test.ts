import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const repositoryPath = "./repository.ts";
const {
  CLAIM_KNOWLEDGE_INDEX_JOB_SQL,
  CLAIM_NEXT_KNOWLEDGE_INDEX_JOB_SQL,
} = await import(repositoryPath) as typeof import("./repository");

function databaseWithKnowledgeSchema() {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE erp_workspace_files (id TEXT PRIMARY KEY NOT NULL)");
  database.exec(readFileSync(new URL("../../../migrations/0005_knowledge_base.sql", import.meta.url), "utf8"));
  database.exec("PRAGMA foreign_keys = OFF");
  return database;
}

function insertRunningJob(database: DatabaseSync, input: {
  id: string;
  requestedAt: string;
  leaseExpiresAt: string;
  leaseOwner?: string;
}) {
  database.prepare(`INSERT INTO erp_knowledge_index_jobs
    (id,tenant_id,document_id,index_generation,status,reason,attempts,available_at,lease_owner,lease_expires_at,
      requested_at,requested_by,started_at,updated_at)
    VALUES (?1,'e3',?1,1,'running','test',1,?2,?3,?4,?2,'tester',?2,?2)`)
    .run(input.id, input.requestedAt, input.leaseOwner || "dead-worker", input.leaseExpiresAt);
}

test("D1 claim SQL atomically reclaims only expired running leases", () => {
  const database = databaseWithKnowledgeSchema();
  try {
    insertRunningJob(database, {
      id: "expired-specific",
      requestedAt: "2035-01-01T00:00:00.000Z",
      leaseExpiresAt: "2035-01-01T00:01:00.000Z",
    });
    const specific = database.prepare(CLAIM_KNOWLEDGE_INDEX_JOB_SQL);
    assert.equal(specific.get(
      "replacement", "2035-01-01T00:01:20.000Z", "2035-01-01T00:00:59.000Z", "expired-specific", "e3",
    ), undefined);
    const reclaimed = specific.get(
      "replacement", "2035-01-01T00:01:31.000Z", "2035-01-01T00:01:01.000Z", "expired-specific", "e3",
    ) as Record<string, unknown>;
    assert.equal(reclaimed.status, "running");
    assert.equal(reclaimed.attempts, 2);
    assert.equal(reclaimed.lease_owner, "replacement");

    insertRunningJob(database, {
      id: "expired-next",
      requestedAt: "2035-01-01T00:00:30.000Z",
      leaseExpiresAt: "2035-01-01T00:01:10.000Z",
    });
    const next = database.prepare(CLAIM_NEXT_KNOWLEDGE_INDEX_JOB_SQL).get(
      "next-worker", "2035-01-01T00:01:45.000Z", "2035-01-01T00:01:15.000Z", "e3",
    ) as Record<string, unknown>;
    assert.equal(next.id, "expired-next");
    assert.equal(next.attempts, 2);
    assert.equal(next.lease_owner, "next-worker");
  } finally {
    database.close();
  }
});

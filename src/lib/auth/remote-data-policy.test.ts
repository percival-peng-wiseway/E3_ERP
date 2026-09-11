import assert from "node:assert/strict";
import { test } from "node:test";

const policyModule = "./remote-data-policy.ts";
const { remoteDataMutationBlocked } = await import(policyModule) as typeof import("./remote-data-policy");

const remoteDevelopment = { nodeEnv: "development", remoteDataReadOnly: "true" };
const mutationMethods = ["POST", "PUT", "PATCH", "DELETE"];
const businessPaths = ["/api/reports", "/api/payment-track/projects", "/api/settings/agent/skills", "/api/files"];

test("production writes are not blocked by an accidentally inherited development flag", () => {
  for (const method of mutationMethods) {
    for (const pathname of businessPaths) {
      assert.equal(remoteDataMutationBlocked(method, pathname, {
        nodeEnv: "production",
        remoteDataReadOnly: "true",
      }), false, `${method} ${pathname}`);
    }
  }
});

test("local remote-data mode still blocks business mutations", () => {
  for (const method of mutationMethods) {
    for (const pathname of businessPaths) {
      assert.equal(remoteDataMutationBlocked(method, pathname, remoteDevelopment), true, `${method} ${pathname}`);
    }
  }
  assert.equal(remoteDataMutationBlocked("post", "/api/reports", remoteDevelopment), true);
});

test("local remote-data mode permits safe HTTP methods and non-API pages", () => {
  for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
    assert.equal(remoteDataMutationBlocked(method, "/api/reports", remoteDevelopment), false);
  }
  assert.equal(remoteDataMutationBlocked("POST", "/reports", remoteDevelopment), false);
});

test("only the existing read-only Agent POST endpoints are exempt", () => {
  for (const pathname of ["/api/agent", "/api/agent/attachments/status", "/api/agent/chat"]) {
    assert.equal(remoteDataMutationBlocked("POST", pathname, remoteDevelopment), false);
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      assert.equal(remoteDataMutationBlocked(method, pathname, remoteDevelopment), true);
    }
  }
  for (const pathname of ["/api/agent/attachments", "/api/agent/conversations", "/api/agent/chat/extra"]) {
    assert.equal(remoteDataMutationBlocked("POST", pathname, remoteDevelopment), true);
  }
});

test("ordinary local development remains writable without the explicit remote-data flag", () => {
  for (const remoteDataReadOnly of [undefined, "false", ""]) {
    assert.equal(remoteDataMutationBlocked("POST", "/api/reports", {
      nodeEnv: "development",
      remoteDataReadOnly,
    }), false);
  }
});

test("an unknown runtime with an explicit read-only flag stays protected", () => {
  assert.equal(remoteDataMutationBlocked("DELETE", "/api/files", { remoteDataReadOnly: "true" }), true);
});

test("team workspace permits isolated local saves without allowing production mutations", () => {
  assert.equal(remoteDataMutationBlocked("POST", "/api/team-workspace", { nodeEnv: "development", remoteDataReadOnly: "true" }), false);
  assert.equal(remoteDataMutationBlocked("POST", "/api/payment-track", { nodeEnv: "development", remoteDataReadOnly: "true" }), true);
  assert.equal(remoteDataMutationBlocked("POST", "/api/team-workspace", { nodeEnv: "test", remoteDataReadOnly: "true" }), true);
});

import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { permissionsForRole } from "./authz.ts";
import type { AgentAuthContext, ToolEnvelope } from "./contracts";
import type { BusinessDataProvider } from "./data-provider";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { BusinessToolExecutor } from "./tools.ts";

const ok = <T>(data: T): ToolEnvelope<T> => ({ ok: true, data, error_code: null, source: "fake", source_record_ids: ["1"], updated_at: "2026-08-27T00:00:00Z", retryable: false });

function context(role: string): AgentAuthContext {
  return { principalHash: "opaque", tenantId: "e3", role, permissions: permissionsForRole(role) };
}

test("inventory tool preserves ERP quantities and rejects extra arguments", async () => {
  let calls = 0;
  const provider: BusinessDataProvider = {
    async getInventory() { calls += 1; return ok([{ sku: "INV-1", product_name: "Panel", warehouse_id: "MEL", warehouse_name: "Melbourne", on_hand: 10, reserved: 7, available: 99, incoming: 4, uom: "ea" }]); },
    async searchKnowledge() { return ok([]); }, async getProject() { throw new Error("unused"); }, async getOrderFinance() { throw new Error("unused"); },
  };
  const executor = new BusinessToolExecutor(provider, context("admin"));
  const result = await executor.execute("get_inventory", JSON.stringify({ sku: "INV-1" }));
  assert.equal(result.result.data && (result.result.data as Array<{ available: number }>)[0]?.available, 99);
  const invalid = await executor.execute("get_inventory", JSON.stringify({ sku: "INV-1", user_id: "victim" }));
  assert.equal(invalid.result.error_code, "invalid_input");
  assert.equal(calls, 1);
});

test("tool layer blocks finance before touching the provider", async () => {
  let called = false;
  const provider = {
    async getInventory() { return ok([]); }, async searchKnowledge() { return ok([]); }, async getProject() { throw new Error("unused"); },
    async getOrderFinance() { called = true; throw new Error("must not run"); },
  } satisfies BusinessDataProvider;
  const result = await new BusinessToolExecutor(provider, context("sales"))
    .execute("get_order_finance_details", JSON.stringify({ order_no: "SO-20" }));
  assert.equal(result.result.error_code, "permission_denied");
  assert.equal(called, false);
});

test("knowledge scope comes only from server auth and is rejected in model arguments", async () => {
  let called = false;
  const provider = {
    async getInventory() { return ok([]); },
    async searchKnowledge() { called = true; return ok([]); },
    async getProject() { throw new Error("unused"); },
    async getOrderFinance() { throw new Error("unused"); },
  } satisfies BusinessDataProvider;
  const executor = new BusinessToolExecutor(provider, context("admin"));
  const invalid = await executor.execute("search_knowledge_base", JSON.stringify({
    query: "warranty",
    limit: 4,
    access_scope: "admin",
  }));
  assert.equal(invalid.result.error_code, "invalid_input");
  assert.equal(called, false);

  const valid = await executor.execute("search_knowledge_base", JSON.stringify({ query: "warranty", limit: 4 }));
  assert.equal(valid.result.ok, true);
  assert.equal(called, true);
});

test("unknown is preserved as a finance status and never rewritten as not started", async () => {
  const provider = {
    async getInventory() { return ok([]); }, async searchKnowledge() { return ok([]); }, async getProject() { throw new Error("unused"); },
    async getOrderFinance() { return ok({ order_no: "SO-20", order_status: "open", customer_visible_summary: "Open", project_id: null, loan: { actually_applied: null, status: "unknown" as const, possibly_eligible: null, eligibility_basis: null }, subsidy: { actually_applied: null, status: "unknown" as const, possibly_eligible: null, eligibility_basis: null } }); },
  } satisfies BusinessDataProvider;
  const result = await new BusinessToolExecutor(provider, context("admin"))
    .execute("get_order_finance_details", JSON.stringify({ order_no: "SO-20" }));
  assert.equal((result.result.data as { loan: { status: string } }).loan.status, "unknown");
});

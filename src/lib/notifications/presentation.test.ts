import assert from "node:assert/strict";
import test from "node:test";
import type * as Presentation from "./presentation";

const presentationModule = "./presentation.ts";
const {
  amountAction,
  planningDescription,
  projectCustomerAddress,
  projectCustomerName,
} = await import(presentationModule) as typeof Presentation;

test("payment reminders use the customer name without a project reference", () => {
  assert.equal(projectCustomerName({ customer: { firstName: "  Qiyan\n", lastName: "Guo " } }), "Qiyan Guo");
  assert.equal(projectCustomerName({ customer: { firstName: "Qiyan" } }), "Qiyan");
  assert.equal(projectCustomerName({}), "Customer name required");
});

test("project addresses use readable non-empty parts and a clear fallback", () => {
  assert.equal(projectCustomerAddress({
    customer: {
      addressLine1: "5 Belvedere Avenue",
      suburb: "WHEELERS HILL",
      state: "VIC",
      postcode: "3150",
    },
  }), "5 Belvedere Avenue, WHEELERS HILL VIC 3150");
  assert.equal(projectCustomerAddress({ customer: {} }), "Address required");
  assert.equal(projectCustomerAddress({}), "Address required");
});

test("payment summaries distinguish expected and outstanding amounts", () => {
  assert.equal(
    amountAction(100_000, "outstanding", "Record received payment"),
    "$1,000.00 outstanding · Record received payment",
  );
  assert.equal(
    amountAction(50_000, "expected deposit", "Confirm deposit"),
    "$500.00 expected deposit · Confirm deposit",
  );
  assert.equal(
    amountAction(null, "expected deposit", "Upload deposit proof"),
    "Amount not recorded · Upload deposit proof",
  );
});

test("planning summaries preserve the action after a long, cleaned address", () => {
  const description = planningDescription(`1 Long Street\n${"A".repeat(500)}`, "Installation planning");
  assert.equal(description.length, 360);
  assert.match(description, / · Installation planning$/);
  assert.doesNotMatch(description, /\n/);
  assert.equal(planningDescription("", "Delivery planning"), "Address required · Delivery planning");
});

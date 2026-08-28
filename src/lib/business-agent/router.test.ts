import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { requiredIdentifierClarification, routeMessage } from "./router.ts";

test("routes a single exact inventory task to Flash", () => {
  const result = routeMessage("Show inventory for SKU INV-100");
  assert.equal(result.modelClass, "flash");
  assert.deepEqual(result.requiredDomains, ["inventory"]);
});

test("detects English and Chinese internal knowledge questions", () => {
  assert.deepEqual(routeMessage("What does the installation manual say?").requiredDomains, ["knowledge"]);
  assert.deepEqual(routeMessage("电池质保手册怎么规定？").requiredDomains, ["knowledge"]);
  assert.deepEqual(routeMessage("E117 appeared twice. What should I save?").requiredDomains, ["knowledge"]);
  assert.deepEqual(routeMessage("What is the 5 kW export acceptance tolerance?").requiredDomains, ["knowledge"]);
});

test("routes multi-domain work and customer finance judgement to Pro", () => {
  assert.equal(routeMessage("Assess project PROJ-20 against inventory SKU INV-100").modelClass, "pro");
  assert.equal(routeMessage("Is customer order SO-20 eligible for a loan?").modelClass, "pro");
});

test("asks for required identifiers rather than guessing", () => {
  assert.match(requiredIdentifierClarification("What is the project progress?", ["project"]) || "", /项目编号/);
  assert.equal(requiredIdentifierClarification("Show project PROJ-20", ["project"]), null);
  assert.equal(requiredIdentifierClarification("What is the inventory handling policy?", ["inventory", "knowledge"]), null);
  assert.equal(requiredIdentifierClarification("What is the project handover procedure?", ["knowledge", "project"]), null);
});

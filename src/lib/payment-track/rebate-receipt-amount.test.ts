import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const inputValidationModule = "./input-validation.ts";
const { paymentTrackAmountToCents } = await import(inputValidationModule) as typeof import("./input-validation");

const [componentSource, styleSource, routeSource, repositorySource] = await Promise.all([
  readFile(new URL("../../components/payment-track-workspace.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../components/payment-track-workspace.module.css", import.meta.url), "utf8"),
  readFile(new URL("../../app/api/payment-track/[id]/route.ts", import.meta.url), "utf8"),
  readFile(new URL("./repository.ts", import.meta.url), "utf8"),
]);

test("all rebate receipt confirmations require an amount and current project version", () => {
  for (const action of ["confirm_stc_solar", "confirm_stc_battery", "confirm_solar_rebate"]) {
    assert.match(routeSource, new RegExp(`"${action}"`));
  }
  assert.match(routeSource, /const REBATE_RECEIPT_FIELDS = new Set\(\[[\s\S]*?"amount"[\s\S]*?"expectedUpdatedAt"/);
  assert.match(routeSource, /REBATE_RECEIPT_ACTIONS\.has\(action\)[\s\S]*?parsed <= 0/);
  assert.match(repositorySource, /requireCurrentProjectVersion\(project, input\.expectedUpdatedAt\);[\s\S]*?validatePositiveRebateReceiptAmount/);
});

test("rebate receipt currency values preserve cents and reject unsafe formats", () => {
  assert.equal(paymentTrackAmountToCents("1400"), 140_000);
  assert.equal(paymentTrackAmountToCents("3,100.25"), 310_025);
  assert.equal(paymentTrackAmountToCents("0"), 0);
  assert.equal(paymentTrackAmountToCents("-1"), null);
  assert.equal(paymentTrackAmountToCents("1.234"), null);
  assert.equal(paymentTrackAmountToCents(1400), null);
  assert.equal(paymentTrackAmountToCents("1000000000.01"), null);
});

test("the confirmation modal records a positive amount without using customer payment state", () => {
  assert.match(componentSource, /const \[rebateReceiptAmount, setRebateReceiptAmount\] = useState\(""\)/);
  assert.match(componentSource, /amount received \(AUD\)/);
  assert.match(componentSource, /inputMode="decimal"/);
  assert.match(componentSource, /This does not reduce the customer outstanding balance\./);
  assert.match(componentSource, /amount: rebateReceiptAmount,[\s\S]*?expectedUpdatedAt:/);
  assert.match(componentSource, /Rebate Receipts/);
  assert.match(componentSource, /Amount not recorded/);
  assert.match(styleSource, /@media \(max-width: 760px\)[\s\S]*?\.stcActions \{ grid-template-columns: 1fr; \}/);
});

test("rebate receipts are persisted separately from customer outstanding payments", () => {
  assert.match(repositorySource, /project\.stcSolarReceivedAmountCents = amount/);
  assert.match(repositorySource, /project\.stcBatteryReceivedAmountCents = amount/);
  assert.match(repositorySource, /project\.solarRebateReceivedAmountCents = amount/);
  const confirmedCentsExpression = repositorySource.match(/const confirmedCents = [\s\S]*?;\n  return \{/);
  assert.ok(confirmedCentsExpression);
  assert.doesNotMatch(confirmedCentsExpression[0], /stcSolarReceivedAmountCents|stcBatteryReceivedAmountCents|solarRebateReceivedAmountCents/);
});

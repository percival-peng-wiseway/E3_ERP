import assert from "node:assert/strict";
import test from "node:test";

const modulePath = "./rebate-receipts.ts";
const {
  formatRebateReceiptAmountAnswer,
  isRebateReceiptAmountIntent,
} = await import(modulePath) as typeof import("./rebate-receipts");

type Project = Parameters<typeof formatRebateReceiptAmountAnswer>[1][number];

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    reference: "PAY-2026-0001",
    quoteNumber: "QN20260001",
    customer: {
      firstName: "Test",
      lastName: "Customer",
      phone: "",
      email: "",
      addressLine1: "",
      suburb: "",
      state: "VIC",
      postcode: "3000",
    },
    stcSolarRequired: true,
    stcBatteryRequired: true,
    solarRebateRequired: true,
    stcSolarReceivedAt: "2026-08-28T01:00:00.000Z",
    stcBatteryReceivedAt: "2026-08-28T02:00:00.000Z",
    solarRebateReceivedAt: "2026-08-28T03:00:00.000Z",
    stcSolarReceivedAmountCents: 310_025,
    stcBatteryReceivedAmountCents: 145_050,
    solarRebateReceivedAmountCents: 140_000,
    ...overrides,
  };
}

test("recognizes English and Chinese rebate receipt amount questions without widening status questions", () => {
  for (const message of [
    "How much STC Rebate was received?",
    "What Solar STC amount was paid?",
    "Solar Rebate received amount",
    "STC rebate 收了多少钱",
    "Solar Rebate 到账金额是多少？",
    "Battery STC 收款总额",
  ]) {
    assert.equal(isRebateReceiptAmountIntent(message), true, message);
  }
  for (const message of [
    "Which STC receipts are pending?",
    "Has Solar Rebate been received?",
    "How much customer payment is outstanding?",
    "How much customer payment was received for this Solar Rebate project?",
    "How much deposit was received for PAY-2026-0001 Solar Rebate project?",
    "这个 Solar Rebate 项目的客户尾款收了多少钱？",
    "STC Rebate 有几笔待确认？",
  ]) {
    assert.equal(isRebateReceiptAmountIntent(message), false, message);
  }
});

test("a specific project answer keeps third-party receipts separate from customer payments", () => {
  const answer = formatRebateReceiptAmountAnswer(
    "How much Solar STC was received for PAY-2026-0001?",
    [project({ stcSolarReceivedAt: "2026-08-28T14:30:00.000Z" }), project({ id: "project-2", reference: "PAY-2026-0002", quoteNumber: "QN20260002" })],
  );
  assert.ok(answer);
  assert.match(answer.answer, /PAY-2026-0001/);
  assert.doesNotMatch(answer.answer, /PAY-2026-0002/);
  assert.match(answer.answer, /AUD 3,100\.25/);
  assert.match(answer.answer, /29\/08\/2026/, "receipt dates use Australia\/Melbourne rather than the UTC date");
  assert.doesNotMatch(answer.answer, /2026-08-28/);
  assert.match(answer.answer, /third-party funding receipts/);
  assert.match(answer.answer, /do not reduce customer outstanding balances/);
  assert.doesNotMatch(answer.answer, /AUD 1,450\.50|AUD 1,400\.00/);
});

test("an English aggregate totals only recorded receipt amounts and discloses missing values", () => {
  const answer = formatRebateReceiptAmountAnswer("How much STC Rebate was received?", [
    project(),
    project({
      id: "project-2",
      reference: "PAY-2026-0002",
      quoteNumber: "QN20260002",
      stcSolarReceivedAt: "2026-08-28T04:00:00.000Z",
      stcSolarReceivedAmountCents: null,
      stcBatteryReceivedAt: null,
      stcBatteryReceivedAmountCents: null,
      solarRebateReceivedAt: null,
      solarRebateReceivedAmountCents: null,
    }),
  ]);
  assert.ok(answer);
  assert.match(answer.answer, /AUD 5,950\.75/);
  assert.match(answer.answer, /1 received receipt has no recorded amount/);
  assert.match(answer.answer, /2 required receipts are still awaiting confirmation/);
  assert.match(answer.answer, /separate from customer payments/);
});

test("a Chinese aggregate states the funding and outstanding separation", () => {
  const answer = formatRebateReceiptAmountAnswer("STC rebate 收了多少钱", [project()]);
  assert.ok(answer);
  assert.match(answer.answer, /AUD 5,950\.75/);
  assert.match(answer.answer, /第三方补贴资金/);
  assert.match(answer.answer, /不会减少客户未收尾款/);
});

test("an unknown explicit project reference never falls back to a workspace-wide total", () => {
  const answer = formatRebateReceiptAmountAnswer(
    "How much Solar Rebate was received for PAY-2026-9999?",
    [project()],
  );
  assert.ok(answer);
  assert.match(answer.answer, /project was not found/i);
  assert.doesNotMatch(answer.answer, /AUD 1,400\.00/);
});

import assert from "node:assert/strict";
import test from "node:test";

const modulePath = "./create-input.ts";
const { parsePaymentTrackCreateInput } = await import(modulePath) as typeof import("./create-input");

function validBody() {
  return {
    actorRole: "sales",
    quoteNumber: "CPEC9999",
    specialist: { name: "Sam", phone: "0400000000" },
    customer: {
      firstName: "Test",
      lastName: "Customer",
      phone: "0411111111",
      email: "test@example.com",
      addressLine1: "1 Test Street",
      suburb: "Melbourne",
      state: "VIC",
      postcode: "3000",
    },
    items: [{
      category: "Battery",
      description: "Home battery",
      model: "CQ7-L4",
      capacity: "27.84kWh",
      quantity: 1,
    }],
    balanceDue: "5100.00",
    expectedDeposit: "1000.00",
    stcSolarRequired: false,
    stcBatteryRequired: false,
    solarRebateRequired: true,
  } satisfies Record<string, unknown>;
}

test("strict imported proposal data is bounded and derives STC flags from items", () => {
  const parsed = parsePaymentTrackCreateInput(validBody(), { exact: true, deriveStcFlags: true });
  assert.ok(parsed);
  assert.equal(parsed.balanceDueCents, 510_000);
  assert.equal(parsed.expectedDepositCents, 100_000);
  assert.equal(parsed.stcSolarRequired, false);
  assert.equal(parsed.stcBatteryRequired, true);
  assert.equal(parsed.solarRebateRequired, true);
  assert.equal(parsed.solarRebateQrRequired, true);
});

test("strict imported proposal data requires a rebate assessment", () => {
  const body = validBody();
  delete (body as Partial<typeof body>).solarRebateRequired;
  assert.equal(parsePaymentTrackCreateInput(body, { exact: true, deriveStcFlags: true }), null);
});

test("strict imported proposal data does not create Solar STC for an inverter-only item", () => {
  const body = validBody();
  body.items = [{
    category: "Solar Inverter",
    description: "Hybrid inverter",
    model: "KH10",
    capacity: "10kW",
    quantity: 1,
  }];
  const parsed = parsePaymentTrackCreateInput(body, { exact: true, deriveStcFlags: true });
  assert.ok(parsed);
  assert.equal(parsed.stcSolarRequired, false);
  assert.equal(parsed.stcBatteryRequired, false);
});

test("strict imported proposal data rejects unknown nested fields", () => {
  const body = validBody();
  body.customer = { ...body.customer, unsafe: "ignored" } as typeof body.customer;
  assert.equal(parsePaymentTrackCreateInput(body, { exact: true, deriveStcFlags: true }), null);
});

test("manual project data remains backward compatible with optional rebate fields", () => {
  const body = validBody();
  delete (body as Partial<typeof body>).solarRebateRequired;
  const parsed = parsePaymentTrackCreateInput(body);
  assert.ok(parsed);
  assert.equal(parsed.solarRebateRequired, false);
});

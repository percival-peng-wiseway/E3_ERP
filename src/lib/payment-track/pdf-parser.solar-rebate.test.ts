import assert from "node:assert/strict";
import { test } from "node:test";

const parserModule = "./pdf-parser.ts";
const {
  assessProposalSolarRebateRequirement,
  proposalRequiresSolarRebate,
} = await import(parserModule) as typeof import("./pdf-parser");

test("recognises only an explicit Solar Rebate line in the System Quote price block", () => {
  assert.equal(proposalRequiresSolarRebate(`
    System Quote for Solar and Battery System
    System Price $12,000.00
    Less Solar Rebate $1,400.00
    Balance Due $10,600.00
    Important Notice to the Customer
  `), true);
  assert.equal(proposalRequiresSolarRebate(`
    System Quote for Solar and Battery System
    System Price $12,000.00
    Less: Federal Solar
    Rebate $1,400.00
    Balance Due $10,600.00
    Customer Signature
  `), true);
});

test("does not treat Battery Rebate, STC or generic rebate wording as Solar Rebate", () => {
  assert.equal(proposalRequiresSolarRebate(`
    System Quote for Battery Storage System : 20.88 kWh
    System Price $9,954.50
    Less Federal Battery Rebate STC QTY: 123 As at day STC Value: $41.50 - $5,104.50
    Kindly note that the STC incentive value is GST Free
    Balance Due $4,850.00
    Important Notice to the Customer
  `), false);
  assert.equal(proposalRequiresSolarRebate(`
    System Quote for Solar System
    Less Solar STC rebate $3,000.00
    Balance Due $7,000.00
  `), false);
  assert.equal(proposalRequiresSolarRebate(`
    System Quote for Solar System
    Balance Due $7,000.00
    Terms and Conditions
    The customer may separately qualify for a Solar Rebate.
  `), false);
  assert.equal(proposalRequiresSolarRebate("A rebate or STC may apply to this solar installation."), false);
});

test("distinguishes an authoritative negative from an unassessable document", () => {
  assert.equal(assessProposalSolarRebateRequirement(`
    System Quote for Battery Storage System
    System Price $9,954.50
    Less Federal Battery Rebate $5,104.50
    Balance Due $4,850.00
    Important Notice to the Customer
  `), false);
  assert.equal(assessProposalSolarRebateRequirement(`
    Solar Agreement
    Terms and Conditions
    A rebate or STC may apply.
  `), null);
  assert.equal(assessProposalSolarRebateRequirement(""), null);
});

test("assesses Solar Rebate only inside a complete GreenSketch deductions block", () => {
  assert.equal(assessProposalSolarRebateRequirement(`
    Quotation
    Solar Panel: LONGi LR5-54HTH-440M / 440W x 14
    System Total (incl. GST) $12,400.00
    Deductions
    Solar Rebate - $400.00
    Deposit $1,000.00
    Final Price (incl. GST) $11,000.00
  `), true);

  assert.equal(assessProposalSolarRebateRequirement(`
    Quotation
    Battery: Huawei LUNA2000-7-S1 / 13.8 kWh x 2
    System Total (incl. GST) $12,000.00
    Deductions
    Battery Rebate $2,000.00
    Deposit $1,000.00
    Final Price (incl. GST) $9,000.00
    Terms mention Solar Rebate eligibility separately.
  `), false);

  assert.equal(assessProposalSolarRebateRequirement(`
    Quotation
    Solar Panel: LONGi LR5-54HTH-440M / 440W x 14
    System Total (incl. GST) $12,400.00
    Deductions
    Solar Rebate pending assessment
    Final Price (incl. GST) $12,400.00
  `), null);

  assert.equal(assessProposalSolarRebateRequirement(`
    Quotation
    Solar Panel: LONGi LR5-54HTH-440M / 440W x 14
    System Total (incl. GST) $12,400.00
    Solar Rebate - $400.00
  `), null);
});

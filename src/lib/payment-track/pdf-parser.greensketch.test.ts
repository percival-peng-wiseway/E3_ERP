import assert from "node:assert/strict";
import test from "node:test";

const parserModule = "./pdf-parser.ts";
const {
  parsePaymentAgreementPdf,
  PaymentAgreementParseError,
} = await import(parserModule) as typeof import("./pdf-parser");

function textPdf(lines: string[]) {
  const escapeText = (value: string) => value.replace(/([\\()])/g, "\\$1");
  const content = [
    "BT",
    "/F1 11 Tf",
    "72 760 Td",
    ...lines.flatMap((line, index) => [
      ...(index ? ["0 -18 Td"] : []),
      `(${escapeText(line)}) Tj`,
    ]),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let document = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(document, "latin1"));
    document += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(document, "latin1");
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    document += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(document, "latin1"));
}

test("parses GreenSketch-style parties, pricing and quoted items", async () => {
  const parsed = await parsePaymentAgreementPdf(textPdf([
    "Prepared for By",
    "Old Customer Ruihan Wrong",
    "old@example.com ruihan.old@e3energy.com.au",
    "0400000000 0400000001",
    "99 Old Street, Geelong VIC 3220, Australia",
    "Prepared for By",
    "Ruihan Customer Ruihan Chen",
    "customer@example.com ruihan+sales@e3energy.com.au",
    "0412345678 0498765432",
    "1 Test Street, Melbourne VIC 3000, Australia",
    "Quote No. QN202608260001",
    "Quotation",
    "Solar Panel: LONGi Hi-MO 6 / LR5-54HTH-440M - 440W x 14",
    "Inverter: Huawei SUN2000-10KTL-M1 / AS/NZS 4777.2:2020 x 1",
    "Battery: Huawei LUNA2000-7-S1 / Smart String ESS - 13.8 kWh x 2",
    "Sub-switchboard x 1 Job",
    "AC Cable Run x 12 Meter",
    "Installation Cost x 1 Job",
    "Delivery Cost x 1 Job",
    "System Total (incl. GST) $12,400.00",
    "Deductions",
    "Solar Rebate - $400.00",
    "Deposit $1,000.00",
    "Final Price (incl. GST) $11,000.00",
  ]));

  assert.equal(parsed.quoteNumber, "QN202608260001");
  assert.deepEqual(parsed.specialist, { name: "Ruihan Chen", phone: "0498765432" });
  assert.deepEqual(parsed.customer, {
    firstName: "Ruihan",
    lastName: "Customer",
    phone: "0412345678",
    email: "customer@example.com",
    addressLine1: "1 Test Street",
    suburb: "Melbourne",
    state: "VIC",
    postcode: "3000",
  });
  assert.equal(parsed.balanceDueCents, 1_100_000);
  assert.equal(parsed.expectedDepositCents, 100_000);
  assert.equal(parsed.solarRebateRequired, true);
  assert.equal(parsed.stcSolarRequired, true);
  assert.equal(parsed.stcBatteryRequired, true);
  assert.equal(parsed.items.some((item) => item.category === "Solar Panel"
    && item.model === "LONGi Hi-MO 6 / LR5-54HTH-440M - 440W"
    && item.capacity === "440W"
    && item.quantity === 14), true);
  assert.equal(parsed.items.some((item) => item.category === "Solar Inverter"
    && item.model === "Huawei SUN2000-10KTL-M1 / AS/NZS 4777.2:2020"), true);
  assert.equal(parsed.items.some((item) => item.category === "Battery"
    && item.model === "Huawei LUNA2000-7-S1 / Smart String ESS - 13.8 kWh"
    && item.capacity === "13.8kWh"
    && item.quantity === 2), true);
  assert.equal(parsed.items.some((item) => item.description === "Sub switchboard" && item.quantity === 1), true);
  assert.equal(parsed.items.some((item) => item.description === "AC Cable Run" && item.quantity === 12), true);
});

test("rejects a GreenSketch quote when an advertised core item cannot be parsed", async () => {
  await assert.rejects(
    parsePaymentAgreementPdf(textPdf([
      "Prepared for By",
      "Test Customer Ruihan Chen",
      "customer@example.com ruihan@e3energy.com.au",
      "0412345678 0498765432",
      "1 Test Street, Melbourne VIC 3000, Australia",
      "Quote No. QN202608260002",
      "Quotation",
      "Solar Panel: LONGi LR5-54HTH-440M quantity fourteen",
      "Inverter: Huawei SUN2000-10KTL-M1 x 1",
      "Installation Cost x 1 Job",
      "System Total (incl. GST) $12,000.00",
      "Deductions",
      "Deposit $1,000.00",
      "Final Price (incl. GST) $11,000.00",
    ])),
    (error: unknown) => error instanceof PaymentAgreementParseError
      && error.missingFields.includes("Solar Panel item details"),
  );
});

test("rejects a GreenSketch quote without a complete customer address", async () => {
  await assert.rejects(
    parsePaymentAgreementPdf(textPdf([
      "Prepared for By",
      "Test Customer Ruihan Chen",
      "customer@example.com ruihan@e3energy.com.au",
      "0412345678 0498765432",
      "Melbourne VIC 3000, Australia",
      "Quote No. QN202608260003",
      "Quotation",
      "Solar Panel: LONGi LR5-54HTH-440M 440W x 14",
      "Inverter: Huawei SUN2000-10KTL-M1 x 1",
      "System Total (incl. GST) $12,000.00",
      "Deductions",
      "Deposit $1,000.00",
      "Final Price (incl. GST) $11,000.00",
    ])),
    (error: unknown) => error instanceof PaymentAgreementParseError
      && error.missingFields.includes("installation address"),
  );
});

test("rejects a new proposal when the Solar Rebate row cannot be assessed safely", async () => {
  await assert.rejects(
    parsePaymentAgreementPdf(textPdf([
      "Prepared for By",
      "Test Customer Ruihan Chen",
      "customer@example.com ruihan@e3energy.com.au",
      "0412345678 0498765432",
      "1 Test Street, Melbourne VIC 3000, Australia",
      "Quote No. QN202608260004",
      "Quotation",
      "Solar Panel: LONGi LR5-54HTH-440M 440W x 14",
      "Inverter: Huawei SUN2000-10KTL-M1 x 1",
      "System Total (incl. GST) $12,000.00",
      "Deductions",
      "Solar Rebate pending assessment",
      "SolarVIC's Solar PV Interest-Free Loan - $1,400.00",
      "Deposit $1,000.00",
      "Final Price (incl. GST) $11,000.00",
    ])),
    (error: unknown) => error instanceof PaymentAgreementParseError
      && error.missingFields.includes("Solar Rebate assessment"),
  );
});

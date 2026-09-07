import assert from "node:assert/strict";
import test from "node:test";

const parserModule = "./pdf-parser.ts";
const { parsePaymentAgreementPdf } = await import(parserModule) as typeof import("./pdf-parser");

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

test("keeps the existing Blink proposal import compatible with explicit format selection", async () => {
  const parsed = await parsePaymentAgreementPdf(textPdf([
    "Proposal No: BLINK-2026-001",
    "Solar Specialist: Alex Seller Mobile: 0412 222 333",
    "First Name: Sample Last Name: Customer Contact No.: 0433 333 444 Email: sample@example.com",
    "Installation Address",
    "Address Line 1: 10 Solar Street Address Line 2:",
    "Suburb: Melbourne State: VIC Postcode: 3000",
    "Installation Information",
    "System Quote",
    "Solar Panels Manufacturer Model Capacity Quantity",
    "LONGI LR7-54HVH-475M 475W 14",
    "Solar Inverter Manufacturer Model Capacity Quantity",
    "FOX ESS KH8 8kW 1",
    "Battery Manufacturer Model Capacity Quantity",
    "FOX ESS EQ4800-L9 41.93kWh 1",
    "Installation Standard installation",
    "System Price $13,900.00",
    "Less Solar Rebate $1,400.00",
    "Deposit Amount $1,000.00",
    "Balance Due $12,500.00",
  ]), { format: "blink" });

  assert.equal(parsed.quoteNumber, "BLINK-2026-001");
  assert.deepEqual(parsed.specialist, { name: "Alex Seller", phone: "0412 222 333" });
  assert.deepEqual(parsed.customer, {
    firstName: "Sample",
    lastName: "Customer",
    phone: "0433 333 444",
    email: "sample@example.com",
    addressLine1: "10 Solar Street",
    suburb: "Melbourne",
    state: "VIC",
    postcode: "3000",
  });
  assert.equal(parsed.balanceDueCents, 1_250_000);
  assert.equal(parsed.expectedDepositCents, 100_000);
  assert.equal(parsed.solarRebateRequired, true);
  assert.equal(parsed.stcSolarRequired, true);
  assert.equal(parsed.stcBatteryRequired, true);
  assert.equal(parsed.items.some((item) => item.category === "Solar Panel" && item.quantity === 14), true);
  assert.equal(parsed.items.some((item) => item.category === "Solar Inverter" && item.quantity === 1), true);
  assert.equal(parsed.items.some((item) => item.category === "Battery" && item.quantity === 1), true);
});

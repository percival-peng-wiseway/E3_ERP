export function requiredPaymentTrackText(value: unknown, maximum: number) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maximum ? text : null;
}

export function optionalPaymentTrackText(value: unknown, maximum: number) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length <= maximum ? text : null;
}

export function paymentTrackAmountToCents(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^\$\s*/, "").replaceAll(",", "");
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= 100_000_000_000 ? cents : null;
}

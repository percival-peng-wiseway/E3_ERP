type PaymentReminderProject = {
  customer?: {
    firstName?: unknown;
    lastName?: unknown;
    addressLine1?: unknown;
    suburb?: unknown;
    state?: unknown;
    postcode?: unknown;
  } | null;
};

function cleanText(value: unknown, maximum: number) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum)
    : "";
}

export function aud(cents: number) {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

export function projectCustomerName(project: PaymentReminderProject) {
  return [project.customer?.firstName, project.customer?.lastName]
    .map((part) => cleanText(part, 100))
    .filter(Boolean)
    .join(" ") || "Customer name required";
}

export function projectCustomerAddress(project: PaymentReminderProject) {
  const locality = [project.customer?.suburb, project.customer?.state, project.customer?.postcode]
    .map((part) => cleanText(part, 100))
    .filter(Boolean)
    .join(" ");
  return [cleanText(project.customer?.addressLine1, 180), locality]
    .filter(Boolean)
    .join(", ") || "Address required";
}

export function amountAction(
  amountCents: number | null,
  qualifier: "expected deposit" | "outstanding",
  action: string,
) {
  const amount = amountCents === null ? "Amount not recorded" : `${aud(amountCents)} ${qualifier}`;
  return `${amount} · ${cleanText(action, 100)}`;
}

export function planningDescription(
  address: string,
  action: "Delivery planning" | "Installation planning" | "Installment planning",
) {
  const suffix = ` · ${action}`;
  const addressLabel = cleanText(address, 360 - suffix.length) || "Address required";
  return `${addressLabel}${suffix}`;
}

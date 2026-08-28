export type PaymentTrackQrConfirmationRequest = {
  actorRole: "pm";
  expectedUpdatedAt: string;
};

const CONFIRMATION_FIELDS = new Set(["actorRole", "expectedUpdatedAt"]);

function validProjectVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

/** Strictly parses the no-file PM QR receipt confirmation contract. */
export function parsePaymentTrackQrConfirmation(
  body: Record<string, unknown>,
): PaymentTrackQrConfirmationRequest | null {
  if (Object.keys(body).some((field) => !CONFIRMATION_FIELDS.has(field))
    || Object.keys(body).length !== CONFIRMATION_FIELDS.size
    || body.actorRole !== "pm"
    || !validProjectVersion(body.expectedUpdatedAt)) return null;
  return {
    actorRole: "pm",
    expectedUpdatedAt: body.expectedUpdatedAt,
  };
}

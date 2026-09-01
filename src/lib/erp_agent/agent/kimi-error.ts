export type KimiRequestErrorKind =
  | "bad_request"
  | "authentication"
  | "permission"
  | "model_unavailable"
  | "quota_or_rate_limit"
  | "service_unavailable"
  | "network"
  | "invalid_response";

const ERROR_CODES: Record<KimiRequestErrorKind, string> = {
  bad_request: "kimi_bad_request",
  authentication: "kimi_authentication_failed",
  permission: "kimi_permission_denied",
  model_unavailable: "kimi_model_unavailable",
  quota_or_rate_limit: "kimi_quota_or_rate_limited",
  service_unavailable: "kimi_service_unavailable",
  network: "kimi_network_error",
  invalid_response: "kimi_invalid_response",
};

/**
 * A deliberately content-free model transport error. Never attach the upstream
 * response body, request body, API key or original network error as a cause.
 */
export class KimiRequestError extends Error {
  readonly code: string;
  readonly kind: KimiRequestErrorKind;
  readonly status: number | null;

  constructor(kind: KimiRequestErrorKind, status: number | null = null) {
    super(`Kimi request failed: ${kind}.`);
    this.name = "KimiRequestError";
    this.code = ERROR_CODES[kind];
    this.kind = kind;
    this.status = status;
  }
}

export function kimiHttpError(status: number): KimiRequestError {
  if (status === 401) return new KimiRequestError("authentication", status);
  if (status === 403) return new KimiRequestError("permission", status);
  if (status === 404) return new KimiRequestError("model_unavailable", status);
  if (status === 429) return new KimiRequestError("quota_or_rate_limit", status);
  if (status >= 500) return new KimiRequestError("service_unavailable", status);
  return new KimiRequestError("bad_request", status);
}

export function kimiNetworkError(): KimiRequestError {
  return new KimiRequestError("network");
}

export function safeKimiErrorKind(error: unknown): string | null {
  if (!(error instanceof KimiRequestError)) return null;
  return error.status === null
    ? `KimiRequestError:${error.kind}`
    : `KimiRequestError:${error.kind}:http_${error.status}`;
}

export type KimiRegionForWarning = "china" | "international";

function selectedRegionLabel(region?: KimiRegionForWarning) {
  if (region === "china") return "China";
  if (region === "international") return "International";
  return "selected";
}

export function kimiRequestWarning(
  error: unknown,
  region?: KimiRegionForWarning,
): { code: string; message: string } | null {
  if (!(error instanceof KimiRequestError)) return null;
  const messages: Record<KimiRequestErrorKind, string> = {
    bad_request: "Kimi rejected the request format. Check the Kimi K2.6 integration and try again.",
    authentication: `The Moonshot API key is not valid for the ${selectedRegionLabel(region)} region. Update the key or region in Agent Settings.`,
    permission: "Kimi denied access. Check model permissions and the organisation IP allowlist.",
    model_unavailable: "Kimi K2.6 is not available to this account or selected region. Check model access in Moonshot.",
    quota_or_rate_limit: "Kimi quota is insufficient or the account is rate limited. Check the Moonshot balance or retry shortly.",
    service_unavailable: "Kimi is temporarily unavailable. Retry shortly.",
    network: "The Kimi API could not be reached. Check network access and the selected region, then retry.",
    invalid_response: "Kimi returned an invalid response. Check the integration and retry.",
  };
  return { code: error.code, message: messages[error.kind] };
}

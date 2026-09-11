export type KimiRequestErrorKind =
  | "bad_request"
  | "authentication"
  | "permission"
  | "model_unavailable"
  | "quota_or_rate_limit"
  | "service_unavailable"
  | "network"
  | "invalid_plan"
  | "invalid_response"
  | "output_limit";

const ERROR_CODES: Record<KimiRequestErrorKind, string> = {
  bad_request: "kimi_bad_request",
  authentication: "kimi_authentication_failed",
  permission: "kimi_permission_denied",
  model_unavailable: "kimi_model_unavailable",
  quota_or_rate_limit: "kimi_quota_or_rate_limited",
  service_unavailable: "kimi_service_unavailable",
  network: "kimi_network_error",
  invalid_plan: "kimi_invalid_plan",
  invalid_response: "kimi_invalid_response",
  output_limit: "kimi_output_limit",
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
  modelProvider?: "kimi" | "ollama",
): { code: string; message: string } | null {
  if (!(error instanceof KimiRequestError)) return null;
  if (modelProvider === "ollama") {
    const messages: Record<KimiRequestErrorKind, string> = {
      bad_request: "Qwen rejected the request. Check the Ollama version and model configuration.",
      authentication: "Qwen tunnel authentication failed. Check the server-side tunnel credentials.",
      permission: "The Qwen tunnel denied access. Check its access policy.",
      model_unavailable: "The Qwen model or tunnel endpoint was not found. Check the model name and address.",
      quota_or_rate_limit: "The Qwen service is busy or the tunnel is rate limited. Retry shortly.",
      service_unavailable: "The home Qwen service is unavailable. Check that the computer, Ollama and tunnel are running.",
      network: "The home Qwen service could not be reached in time. Check that the computer, Ollama and tunnel are running.",
      invalid_plan: "Qwen returned a query plan that failed validation. No unvalidated tools were executed. Try a more specific request.",
      invalid_response: "Qwen returned an invalid response. Check the model integration and retry.",
      output_limit: "Qwen reached its output limit. Try a narrower request.",
    };
    return { code: error.code.replace(/^kimi_/, "qwen_"), message: messages[error.kind] };
  }
  const messages: Record<KimiRequestErrorKind, string> = {
    bad_request: "Kimi rejected the request format. Check the Kimi K2.6 integration and try again.",
    authentication: `The Moonshot API key is not valid for the ${selectedRegionLabel(region)} region. Update the key or region in Agent Settings.`,
    permission: "Kimi denied access. Check model permissions and the organisation IP allowlist.",
    model_unavailable: "Kimi K2.6 is not available to this account or selected region. Check model access in Moonshot.",
    quota_or_rate_limit: "Kimi quota is insufficient or the account is rate limited. Check the Moonshot balance or retry shortly.",
    service_unavailable: "Kimi is temporarily unavailable. Retry shortly.",
    network: "The Kimi API could not be reached. Check network access and the selected region, then retry.",
    invalid_plan: "The model returned a query plan that failed validation. No unvalidated tools were executed. Try a more specific request.",
    invalid_response: "Kimi returned an invalid response. Check the integration and retry.",
    output_limit: "The model response exceeded its output limit. Try a shorter summary or a narrower date range.",
  };
  return { code: error.code, message: messages[error.kind] };
}

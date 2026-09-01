import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { KimiRequestError, kimiHttpError, kimiRequestWarning, kimiNetworkError, safeKimiErrorKind } from "./kimi-error.ts";

test("Kimi HTTP statuses map to content-free operational categories", () => {
  const cases = [
    [400, "bad_request", "kimi_bad_request"],
    [401, "authentication", "kimi_authentication_failed"],
    [403, "permission", "kimi_permission_denied"],
    [404, "model_unavailable", "kimi_model_unavailable"],
    [429, "quota_or_rate_limit", "kimi_quota_or_rate_limited"],
    [500, "service_unavailable", "kimi_service_unavailable"],
  ] as const;
  for (const [status, kind, code] of cases) {
    const error = kimiHttpError(status);
    assert.ok(error instanceof KimiRequestError);
    assert.equal(error.kind, kind);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(safeKimiErrorKind(error), `KimiRequestError:${kind}:http_${status}`);
  }
});

test("Kimi warnings are actionable without including upstream content or keys", () => {
  const upstreamMarker = "raw-upstream-secret sk-live-do-not-expose";
  const authentication = kimiRequestWarning(kimiHttpError(401), "china");
  assert.equal(authentication?.code, "kimi_authentication_failed");
  assert.match(authentication?.message || "", /China.*key.*region.*Agent Settings/u);
  assert.equal(JSON.stringify(authentication).includes(upstreamMarker), false);

  const warnings = [400, 403, 404, 429, 500].map((status) => kimiRequestWarning(kimiHttpError(status))?.message || "");
  assert.match(warnings[0] || "", /request format/u);
  assert.match(warnings[1] || "", /permissions.*IP allowlist/u);
  assert.match(warnings[2] || "", /Kimi K2\.6.*account.*region/u);
  assert.match(warnings[3] || "", /quota.*rate limited.*balance/u);
  assert.match(warnings[4] || "", /temporarily unavailable/u);

  const network = kimiNetworkError();
  assert.equal(network.kind, "network");
  assert.match(kimiRequestWarning(network)?.message || "", /could not be reached/u);
  assert.equal(kimiRequestWarning(new Error(upstreamMarker)), null);
});

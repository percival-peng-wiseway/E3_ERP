import assert from "node:assert/strict";
import test from "node:test";

const cookieModule = "./proxy-cookie.ts";
const { proxyRequestHeaders, proxyResponseHeaders } = await import(cookieModule) as typeof import("./proxy-cookie");

const namespace = {
  prefix: "__erp_quotehelp_",
  path: "/api",
  legacyPaths: ["/api/quotehelp"],
};

function setCookies(headers: Headers): string[] {
  const compatible = headers as Headers & { getSetCookie?: () => string[] };
  return compatible.getSetCookie?.() || (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
}

test("proxyRequestHeaders forwards only de-namespaced upstream cookies", () => {
  const request = new Request("https://erp.example.test/api/quotehelp/session", {
    headers: {
      accept: "application/json",
      cookie: "e3_erp_session=private; __erp_quotehelp_session=abc=123; unrelated=value",
    },
  });
  const headers = proxyRequestHeaders(request, namespace);
  assert.equal(headers.get("cookie"), "session=abc=123");
  assert.equal(headers.get("accept"), "application/json");
});

test("legacy QuoteHelp cookies are promoted to /api even without an upstream refresh", () => {
  const request = new Request("https://erp.example.test/api/quotehelp/session", {
    headers: { cookie: "__erp_quotehelp_session=legacy-value" },
  });
  const headers = proxyResponseHeaders(Response.json({ ok: true }), request, namespace);
  const cookies = setCookies(headers);
  assert.ok(cookies.some((cookie) => cookie.includes("__erp_quotehelp_session=legacy-value")
    && cookie.includes("Path=/api") && cookie.includes("Secure")));
  assert.ok(cookies.some((cookie) => cookie.includes("__erp_quotehelp_session=")
    && cookie.includes("Path=/api/quotehelp") && cookie.includes("Max-Age=0")));
});

test("an upstream QuoteHelp refresh rewrites the broad path and expires the legacy path once", () => {
  const upstreamHeaders = new Headers();
  upstreamHeaders.append("set-cookie", "session=fresh; Path=/; Secure; HttpOnly; SameSite=Strict");
  const upstream = new Response(null, { headers: upstreamHeaders });
  const request = new Request("https://erp.example.test/api/quotehelp/session", {
    headers: { cookie: "__erp_quotehelp_session=old" },
  });
  const cookies = setCookies(proxyResponseHeaders(upstream, request, namespace));
  assert.equal(cookies.length, 2);
  assert.ok(cookies.some((cookie) => cookie.includes("__erp_quotehelp_session=fresh")
    && cookie.includes("Path=/api") && cookie.includes("SameSite=Strict")));
  assert.ok(cookies.some((cookie) => cookie.includes("Path=/api/quotehelp")
    && cookie.includes("Max-Age=0")));
});

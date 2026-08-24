import { NextRequest, NextResponse } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import {
  createReimbursementAdminToken,
  isReimbursementAdmin,
  REIMBURSEMENT_ADMIN_COOKIE,
  REIMBURSEMENT_ADMIN_SESSION_SECONDS,
  reimbursementAdminConfiguration,
  verifyReimbursementAdminPassword,
} from "@/lib/reimbursements/auth";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const attempts = new Map<string, { failures: number; blockedUntil: number }>();
const MAX_LOGIN_BODY_SIZE = 4 * 1024;

class RequestBodyTooLarge extends Error {}

async function readLoginBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LOGIN_BODY_SIZE) throw new RequestBodyTooLarge();
  if (!request.body) throw new SyntaxError("Missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_LOGIN_BODY_SIZE) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError("Expected object");
  return parsed as { password?: unknown };
}

function responseBody(request: Request, admin = isReimbursementAdmin(request)) {
  const configuration = reimbursementAdminConfiguration();
  return {
    data: {
      admin,
      configured: configuration.configured,
      ...(configuration.demoPassword ? { demoPassword: configuration.demoPassword } : {}),
    },
  };
}

function noStoreJson(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("cache-control", "no-store");
  return response;
}

function clientKey(request: Request) {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-real-ip")
    || "local";
}

function setAdminCookie(response: NextResponse, value: string, maxAge: number) {
  response.cookies.set(REIMBURSEMENT_ADMIN_COOKIE, value, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/api/reimbursements",
    maxAge,
  });
}

export function GET(request: NextRequest) {
  return noStoreJson(responseBody(request));
}

export async function POST(request: NextRequest) {
  if (!isAuthorizedMutationRequest(request)) {
    return noStoreJson({ error: "This request is not allowed.", code: "forbidden" }, { status: 403 });
  }
  const employeeSession = getErpSession(request);
  if (employeeSession && employeeSession.user.role !== "admin") {
    return noStoreJson({ error: "Administrator access is required.", code: "admin_required" }, { status: 403 });
  }
  const configuration = reimbursementAdminConfiguration();
  if (!configuration.password) {
    return noStoreJson({ error: "Administrator access is not configured.", code: "not_configured" }, { status: 503 });
  }

  const key = clientKey(request);
  const attempt = attempts.get(key);
  if (attempt?.blockedUntil && attempt.blockedUntil > Date.now()) {
    return noStoreJson({ error: "Too many login attempts. Try again later.", code: "rate_limited" }, { status: 429 });
  }

  try {
    const body = await readLoginBody(request);
    const password = typeof body.password === "string" ? body.password : "";
    if (!verifyReimbursementAdminPassword(password)) {
      const failures = (attempt?.failures || 0) + 1;
      attempts.set(key, {
        failures: failures >= 5 ? 0 : failures,
        blockedUntil: failures >= 5 ? Date.now() + 15 * 60_000 : 0,
      });
      return noStoreJson({ error: "The administrator password is incorrect.", code: "invalid_password" }, { status: 401 });
    }

    attempts.delete(key);
    const response = noStoreJson(responseBody(request, true));
    setAdminCookie(response, createReimbursementAdminToken(), REIMBURSEMENT_ADMIN_SESSION_SECONDS);
    return response;
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) {
      return noStoreJson({ error: "The login request is too large.", code: "request_too_large" }, { status: 413 });
    }
    return noStoreJson({ error: "The login request is invalid.", code: "invalid_request" }, { status: 400 });
  }
}

export function DELETE(request: NextRequest) {
  if (!isAuthorizedMutationRequest(request)) {
    return noStoreJson({ error: "This request is not allowed.", code: "forbidden" }, { status: 403 });
  }
  const response = noStoreJson(responseBody(request, false));
  setAdminCookie(response, "", 0);
  return response;
}

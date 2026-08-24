import { NextRequest, NextResponse } from "next/server";
import { verifyErpCredentials } from "@/lib/auth/accounts";
import { normalizeErpUsername } from "@/lib/auth/directory";
import {
  createErpSessionToken,
  erpAuthConfiguration,
  ERP_SESSION_COOKIE,
  ERP_SESSION_SECONDS,
} from "@/lib/auth/session";
import { isSameOriginRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_SIZE = 4 * 1024;
const MAX_ACCOUNT_FAILURES = 5;
const MAX_IP_FAILURES = 25;
const ATTEMPT_WINDOW_MS = 15 * 60_000;
const BLOCK_DURATION_MS = 15 * 60_000;
const MAX_TRACKED_ATTEMPTS = 5_000;

type AttemptRecord = {
  failures: number;
  windowStartedAt: number;
  blockedUntil: number;
  lastSeenAt: number;
};

const attempts = new Map<string, AttemptRecord>();

class LoginBodyTooLarge extends Error {}

function noStoreJson(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("cache-control", "no-store");
  response.headers.set("pragma", "no-cache");
  return response;
}

function clientKey(request: Request) {
  const value = request.headers.get("cf-connecting-ip")
    || request.headers.get("x-real-ip")
    || "local";
  return value.slice(0, 128);
}

function activeAttempt(key: string, now: number) {
  const record = attempts.get(key);
  if (!record) return null;
  if (record.blockedUntil > now) return record;
  if (record.blockedUntil > 0 || record.windowStartedAt + ATTEMPT_WINDOW_MS <= now) {
    attempts.delete(key);
    return null;
  }
  return record;
}

function isBlocked(key: string, now: number) {
  const record = activeAttempt(key, now);
  return Boolean(record && record.blockedUntil > now);
}

function recordFailure(key: string, maximum: number, now: number) {
  const previous = activeAttempt(key, now);
  const failures = (previous?.failures || 0) + 1;
  attempts.set(key, {
    failures,
    windowStartedAt: previous?.windowStartedAt || now,
    blockedUntil: failures >= maximum ? now + BLOCK_DURATION_MS : 0,
    lastSeenAt: now,
  });
}

function pruneAttempts(now: number) {
  for (const [key, record] of attempts) {
    if (record.blockedUntil > now) continue;
    if (record.blockedUntil > 0 || record.windowStartedAt + ATTEMPT_WINDOW_MS <= now) attempts.delete(key);
  }
  if (attempts.size <= MAX_TRACKED_ATTEMPTS) return;
  const oldest = [...attempts.entries()].sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt);
  for (const [key] of oldest.slice(0, attempts.size - MAX_TRACKED_ATTEMPTS)) attempts.delete(key);
}

async function readLoginBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_SIZE) throw new LoginBodyTooLarge();
  if (!request.body) throw new SyntaxError("Missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_SIZE) {
      await reader.cancel().catch(() => undefined);
      throw new LoginBodyTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SyntaxError("Expected object");
  return body as Record<string, unknown>;
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return noStoreJson({ error: "This login request is not allowed.", code: "forbidden" }, { status: 403 });
  }
  if (!erpAuthConfiguration().configured) {
    return noStoreJson({ error: "Employee login is not configured.", code: "not_configured" }, { status: 503 });
  }

  const now = Date.now();
  pruneAttempts(now);
  const ip = clientKey(request);
  const ipKey = `ip:${ip}`;
  if (isBlocked(ipKey, now)) {
    return noStoreJson({ error: "Too many login attempts. Try again later.", code: "rate_limited" }, { status: 429 });
  }

  try {
    const body = await readLoginBody(request);
    const username = typeof body.username === "string" && body.username.length <= 80 ? body.username : "";
    const normalizedUsername = normalizeErpUsername(username) || "invalid";
    const accountKey = `account:${ip}:${normalizedUsername}`;
    if (isBlocked(accountKey, now)) {
      return noStoreJson({ error: "Too many login attempts. Try again later.", code: "rate_limited" }, { status: 429 });
    }
    const password = typeof body.password === "string" && body.password.length <= 200 ? body.password : "";
    const user = username && password ? await verifyErpCredentials(username, password) : null;
    if (!user) {
      recordFailure(ipKey, MAX_IP_FAILURES, now);
      recordFailure(accountKey, MAX_ACCOUNT_FAILURES, now);
      return noStoreJson({ error: "The username or password is incorrect.", code: "invalid_credentials" }, { status: 401 });
    }

    // A successful login clears only that account/IP pair. It must not erase
    // failures against other employees or the aggregate IP protection.
    attempts.delete(accountKey);
    const response = noStoreJson({ data: { user } });
    response.cookies.set(ERP_SESSION_COOKIE, createErpSessionToken(user), {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: ERP_SESSION_SECONDS,
    });
    return response;
  } catch (error) {
    if (error instanceof LoginBodyTooLarge) {
      return noStoreJson({ error: "The login request is too large.", code: "request_too_large" }, { status: 413 });
    }
    if (error instanceof SyntaxError) {
      return noStoreJson({ error: "The login request is invalid.", code: "invalid_request" }, { status: 400 });
    }
    console.error("ERP employee login failed.", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson({ error: "Employee login is temporarily unavailable.", code: "login_unavailable" }, { status: 500 });
  }
}

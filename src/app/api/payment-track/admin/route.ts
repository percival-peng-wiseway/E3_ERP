import { NextRequest, NextResponse } from "next/server";
import { getErpSession } from "@/lib/auth/session";
import {
  createPaymentTrackAdminToken,
  isPaymentTrackAdmin,
  PAYMENT_TRACK_ADMIN_COOKIE,
  PAYMENT_TRACK_ADMIN_SESSION_SECONDS,
  paymentTrackAdminConfiguration,
  verifyPaymentTrackAdminPassword,
} from "@/lib/payment-track/auth";
import {
  declaredPaymentTrackBodyTooLarge,
  paymentTrackError,
  paymentTrackJson,
  PaymentTrackRequestBodyTooLarge,
  readPaymentTrackJson,
} from "@/lib/payment-track/request";
import { isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_LOGIN_BODY_SIZE = 4 * 1024;
const attempts = new Map<string, { failures: number; blockedUntil: number }>();

function responseBody(request: Request, admin = isPaymentTrackAdmin(request)) {
  const configuration = paymentTrackAdminConfiguration();
  return {
    data: {
      admin,
      configured: configuration.configured,
      ...(configuration.demoPassword ? { demoPassword: configuration.demoPassword } : {}),
    },
  };
}

function clientKey(request: Request) {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-real-ip")
    || "local";
}

function setAdminCookie(response: NextResponse, value: string, maxAge: number) {
  response.cookies.set(PAYMENT_TRACK_ADMIN_COOKIE, value, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/api/payment-track",
    maxAge,
  });
}

export function GET(request: NextRequest) {
  return paymentTrackJson(responseBody(request));
}

export async function POST(request: NextRequest) {
  if (!isAuthorizedMutationRequest(request)) return paymentTrackError(403, "forbidden", "This request is not allowed.");
  const employeeSession = getErpSession(request);
  if (employeeSession && employeeSession.user.role !== "admin") {
    return paymentTrackError(403, "admin_required", "Administrator access is required.");
  }
  if (declaredPaymentTrackBodyTooLarge(request, MAX_LOGIN_BODY_SIZE)) {
    return paymentTrackError(413, "request_too_large", "The login request is too large.");
  }
  const configuration = paymentTrackAdminConfiguration();
  if (!configuration.password) return paymentTrackError(503, "not_configured", "Administrator access is not configured.");

  const key = clientKey(request);
  const attempt = attempts.get(key);
  if (attempt?.blockedUntil && attempt.blockedUntil > Date.now()) {
    return paymentTrackError(429, "rate_limited", "Too many login attempts. Try again later.");
  }

  try {
    const body = await readPaymentTrackJson(request, MAX_LOGIN_BODY_SIZE);
    const password = typeof body.password === "string" ? body.password : "";
    if (!verifyPaymentTrackAdminPassword(password)) {
      const failures = (attempt?.failures || 0) + 1;
      attempts.set(key, {
        failures: failures >= 5 ? 0 : failures,
        blockedUntil: failures >= 5 ? Date.now() + 15 * 60_000 : 0,
      });
      return paymentTrackError(401, "invalid_password", "The administrator password is incorrect.");
    }

    attempts.delete(key);
    const response = paymentTrackJson(responseBody(request, true));
    setAdminCookie(response, createPaymentTrackAdminToken(), PAYMENT_TRACK_ADMIN_SESSION_SECONDS);
    return response;
  } catch (error) {
    if (error instanceof PaymentTrackRequestBodyTooLarge) return paymentTrackError(413, "request_too_large", "The login request is too large.");
    return paymentTrackError(400, "invalid_request", "The login request is invalid.");
  }
}

export function DELETE(request: NextRequest) {
  if (!isAuthorizedMutationRequest(request)) return paymentTrackError(403, "forbidden", "This request is not allowed.");
  const response = paymentTrackJson(responseBody(request, false));
  setAdminCookie(response, "", 0);
  return response;
}

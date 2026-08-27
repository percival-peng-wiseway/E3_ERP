import {
  inventoryOperationRequiredRole,
  type InventoryOperationAction,
} from "@/lib/inventory-operations/types";
import { getErpSession } from "@/lib/auth/session";
import { applyProjectSolarConsumptionToOperationsState } from "@/lib/inventory-operations/project-consumption";
import type { ApiState } from "@/lib/inventory-operations/types";
import { listPaymentTrackProjects } from "@/lib/payment-track/repository";
import {
  isAuthorizedActorRequest,
  isAuthorizedMutationRequest,
  isSameOriginRequest,
  proxyRequestHeaders,
  proxyResponseHeaders,
} from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";

const DEFAULT_UPSTREAM_URL = "https://inventory.e3energy.com.au/api/inventory";
const REQUEST_BODY_LIMIT = 512 * 1024;
const UPSTREAM_STATE_LIMIT = 4 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const COOKIE_NAMESPACE = {
  prefix: "__erp_inventory_",
  path: "/api/inventory/operations",
};

const ALLOWED_ACTIONS = new Set<InventoryOperationAction>([
  "adminLogin",
  "adminLogout",
  "editInventory",
  "reportLoss",
  "deleteSku",
  "deleteLog",
  "clearLogs",
  "sale",
  "setStatus",
  "cancelOrder",
  "cancelDelivery",
  "recallDelivery",
  "schedule",
  "editTask",
  "deliver",
  "arrival",
]);

class PayloadTooLargeError extends Error {}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: message, code }, { status });
}

function inventoryTarget(request: Request): URL {
  const target = new URL(process.env.INVENTORY_OPERATIONS_API_URL || DEFAULT_UPSTREAM_URL);
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error("Unsupported inventory upstream protocol");
  }

  // Query values may control filtering, but never the upstream origin or path.
  const incoming = new URL(request.url);
  incoming.searchParams.forEach((value, key) => target.searchParams.append(key, value));
  return target;
}

async function readLimitedBody(
  source: Pick<Request, "headers" | "body">,
  limit: number,
): Promise<Uint8Array> {
  const declaredLength = Number(source.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new PayloadTooLargeError();
  }
  if (!source.body) return new Uint8Array();

  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function asRequestBody(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function relay(upstream: Response, request: Request): Response {
  const hasNoBody = upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
  return new Response(hasNoBody ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: proxyResponseHeaders(upstream, request, COOKIE_NAMESPACE),
  });
}

function isInventoryOperationsState(value: unknown): value is ApiState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<ApiState>;
  return Array.isArray(state.inventory)
    && Array.isArray(state.orders)
    && Array.isArray(state.deliveryHistory)
    && Array.isArray(state.lossHistory)
    && Array.isArray(state.logs)
    && typeof state.admin === "boolean";
}

async function relayInventoryState(upstream: Response, request: Request) {
  if (!upstream.ok) return relay(upstream, request);
  try {
    const bytes = await readLimitedBody(upstream.clone(), UPSTREAM_STATE_LIMIT);
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isInventoryOperationsState(value)) return relay(upstream, request);
    const projects = await listPaymentTrackProjects();
    const state = applyProjectSolarConsumptionToOperationsState(value, projects);
    return new Response(JSON.stringify(state), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: proxyResponseHeaders(upstream, request, COOKIE_NAMESPACE),
    });
  } catch (error) {
    console.error("Project installation consumption overlay failed", error);
    return relay(upstream, request);
  }
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    ((error as { name?: unknown }).name === "TimeoutError" ||
      (error as { name?: unknown }).name === "AbortError")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, { required = false, max = 500 }: { required?: boolean; max?: number } = {}) {
  return typeof value === "string" && value.length <= max && (!required || value.trim().length > 0);
}

function isNonNegativeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown) {
  return Number.isInteger(value) && (value as number) > 0;
}

function validOrderIds(value: unknown) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 200
    && value.every(isPositiveInteger)
    && new Set(value).size === value.length;
}

function validItems(value: unknown) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 100
    && value.every((item) => isRecord(item)
      && isText(item.sku, { required: true, max: 160 })
      && isPositiveInteger(item.quantity));
}

function validDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTime(value: unknown) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validEmail(value: unknown) {
  return typeof value === "string"
    && value.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validatePayload(action: InventoryOperationAction, payload: Record<string, unknown>): string | null {
  const orderAction = ["cancelOrder", "cancelDelivery", "recallDelivery", "deliver"].includes(action);
  if (orderAction) return validOrderIds(payload.orderIds) ? null : "orderIds must be a non-empty array of positive integers.";

  switch (action) {
    case "adminLogin":
      return isText(payload.password, { required: true, max: 200 }) ? null : "The administrator password is invalid.";
    case "adminLogout":
    case "clearLogs":
      return null;
    case "sale":
      return isText(payload.salesRep, { required: true, max: 100 })
        && isText(payload.customer, { required: true, max: 200 })
        && isText(payload.phone, { max: 80 })
        && isText(payload.address, { required: true, max: 500 })
        && isText(payload.note, { max: 2_000 })
        && validTime(payload.deliveryTime)
        && validItems(payload.items)
        ? null : "One or more sales order fields are invalid.";
    case "schedule":
      return validOrderIds(payload.orderIds)
        && isText(payload.address, { required: true, max: 500 })
        && validDate(payload.plannedDate)
        && isText(payload.driver, { required: true, max: 160 })
        && validEmail(payload.driverEmail)
        ? null : "One or more delivery scheduling fields are invalid.";
    case "editTask":
      return validOrderIds(payload.orderIds)
        && isText(payload.customer, { required: true, max: 200 })
        && isText(payload.phone, { max: 80 })
        && isText(payload.address, { required: true, max: 500 })
        && validDate(payload.plannedDate)
        && validTime(payload.deliveryTime)
        && isText(payload.driver, { required: true, max: 160 })
        && validEmail(payload.driverEmail)
        && isText(payload.salesRep, { required: true, max: 100 })
        && isText(payload.note, { max: 2_000 })
        && validItems(payload.items)
        ? null : "One or more delivery task fields are invalid.";
    case "setStatus":
      return isText(payload.sku, { required: true, max: 160 })
        && ["充足", "低库存", "订购中", "积压", "缺货"].includes(String(payload.status))
        ? null : "The inventory status is invalid.";
    case "deleteSku":
      return isText(payload.sku, { required: true, max: 160 }) ? null : "The SKU is invalid.";
    case "deleteLog":
      return isPositiveInteger(payload.logId) ? null : "The log ID is invalid.";
    case "reportLoss":
      return isText(payload.sku, { required: true, max: 160 })
        && isPositiveInteger(payload.quantity)
        && isText(payload.reason, { required: true, max: 1_000 })
        ? null : "One or more stock loss fields are invalid.";
    case "editInventory":
      return isText(payload.originalSku, { required: true, max: 160 })
        && isText(payload.sku, { required: true, max: 160 })
        && isText(payload.category, { required: true, max: 100 })
        && ["充足", "低库存", "订购中", "积压", "缺货"].includes(String(payload.status))
        && isNonNegativeNumber(payload.onHand)
        && isNonNegativeNumber(payload.pending)
        && isNonNegativeNumber(payload.available)
        ? null : "One or more inventory fields are invalid.";
    case "arrival":
      return (payload.mode === "received" || payload.mode === "ordered")
        && isText(payload.rawText, { max: 50_000 })
        && validItems(payload.items)
        ? null : "One or more stock receipt fields are invalid.";
    default:
      return "This inventory action is not allowed.";
  }
}

export async function GET(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return jsonError(403, "ORIGIN_FORBIDDEN", "Only same-origin requests are allowed. Trusted server calls may omit Origin when authenticated.");
  }

  try {
    const upstream = await fetch(inventoryTarget(request), {
      method: "GET",
      headers: proxyRequestHeaders(request, COOKIE_NAMESPACE),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return relayInventoryState(upstream, request);
  } catch (error) {
    console.error("Inventory operations GET proxy failed", error);
    return isTimeout(error)
      ? jsonError(504, "UPSTREAM_TIMEOUT", "The inventory service timed out.")
      : jsonError(502, "UPSTREAM_UNAVAILABLE", "The inventory service is temporarily unavailable.");
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorizedMutationRequest(request)) {
    return jsonError(403, "MUTATION_FORBIDDEN", "Write operations require a same-origin application request or a valid internal service token.");
  }

  const contentType = request.headers.get("content-type") || "";
  if (!/^(application\/json\b|[^;]+\+json\b)/i.test(contentType)) {
    return jsonError(415, "JSON_REQUIRED", "Inventory operations accept JSON request bodies only.");
  }

  let body: Uint8Array;
  let parsed: unknown;
  try {
    body = await readLimitedBody(request, REQUEST_BODY_LIMIT);
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return jsonError(413, "PAYLOAD_TOO_LARGE", "The request body cannot exceed 512 KiB.");
    }
    return jsonError(400, "INVALID_JSON", "The request body must be valid JSON.");
  }

  const action =
    typeof parsed === "object" && parsed !== null && "action" in parsed
      ? (parsed as { action?: unknown }).action
      : undefined;
  if (typeof action !== "string" || !ALLOWED_ACTIONS.has(action as InventoryOperationAction)) {
    return jsonError(400, "ACTION_NOT_ALLOWED", "This inventory action is not allowed.");
  }
  if (!isRecord(parsed)) {
    return jsonError(400, "INVALID_PAYLOAD", "The inventory operation body must be a JSON object.");
  }
  if (!isAuthorizedActorRequest(request, inventoryOperationRequiredRole(action as InventoryOperationAction))) {
    return jsonError(403, "ROLE_FORBIDDEN", "Your signed-in role cannot perform this inventory action.");
  }
  const employeeSession = getErpSession(request);
  const effectivePayload = action === "sale" && employeeSession?.user.role === "sales"
    ? { ...parsed, salesRep: employeeSession.user.displayName }
    : parsed;
  const validationError = validatePayload(action as InventoryOperationAction, effectivePayload);
  if (validationError) {
    return jsonError(400, "INVALID_PAYLOAD", validationError);
  }
  const forwardedBody = effectivePayload === parsed
    ? body
    : new TextEncoder().encode(JSON.stringify(effectivePayload));

  try {
    const upstream = await fetch(inventoryTarget(request), {
      method: "POST",
      headers: proxyRequestHeaders(request, COOKIE_NAMESPACE, "application/json"),
      body: asRequestBody(forwardedBody),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return relay(upstream, request);
  } catch (error) {
    console.error("Inventory operations POST proxy failed", error);
    return isTimeout(error)
      ? jsonError(504, "UPSTREAM_TIMEOUT", "The inventory service timed out.")
      : jsonError(502, "UPSTREAM_UNAVAILABLE", "The inventory service is temporarily unavailable.");
  }
}

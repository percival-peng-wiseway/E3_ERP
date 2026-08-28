import { NextRequest } from "next/server";
import {
  isPaymentTrackAdmin,
  paymentTrackAdminConfiguration,
} from "@/lib/payment-track/auth";
import {
  createManualPaymentTrackProject,
  listPaymentTrackProjects,
  PaymentTrackRepositoryError,
  type CreatePaymentTrackInput,
} from "@/lib/payment-track/repository";
import {
  declaredPaymentTrackBodyTooLarge,
  optionalPaymentTrackText,
  paymentTrackAmountToCents,
  paymentTrackError,
  paymentTrackJson,
  PaymentTrackRequestBodyTooLarge,
  readPaymentTrackJson,
  requiredPaymentTrackText,
} from "@/lib/payment-track/request";
import type {
  PaymentTrackCustomer,
  PaymentTrackItem,
  PaymentTrackSpecialist,
} from "@/lib/payment-track/types";
import { isAuthorizedActorRequest, isAuthorizedMutationRequest } from "@/lib/server/proxy-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_JSON_SIZE = 128 * 1024;

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function specialistValue(value: unknown): PaymentTrackSpecialist | null {
  const source = objectValue(value);
  if (!source) return null;
  const name = requiredPaymentTrackText(source.name, 120);
  const phone = optionalPaymentTrackText(source.phone, 40);
  return name && phone !== null ? { name, phone } : null;
}

function customerValue(value: unknown): PaymentTrackCustomer | null {
  const source = objectValue(value);
  if (!source) return null;
  const firstName = optionalPaymentTrackText(source.firstName, 80);
  const lastName = optionalPaymentTrackText(source.lastName, 80);
  const phone = optionalPaymentTrackText(source.phone, 40);
  const email = optionalPaymentTrackText(source.email, 180);
  const addressLine1 = optionalPaymentTrackText(source.addressLine1, 180);
  const suburb = optionalPaymentTrackText(source.suburb, 100);
  const state = optionalPaymentTrackText(source.state, 30);
  const postcode = optionalPaymentTrackText(source.postcode, 20);
  if ([firstName, lastName, phone, email, addressLine1, suburb, state, postcode].some((field) => field === null)) return null;
  if (!firstName && !lastName) return null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return {
    firstName: firstName || "",
    lastName: lastName || "",
    phone: phone || "",
    email: email || "",
    addressLine1: addressLine1 || "",
    suburb: suburb || "",
    state: state || "",
    postcode: postcode || "",
  };
}

function itemValue(value: unknown): Omit<PaymentTrackItem, "id"> | null {
  const source = objectValue(value);
  if (!source) return null;
  const category = optionalPaymentTrackText(source.category, 80);
  const description = optionalPaymentTrackText(source.description, 240);
  const model = optionalPaymentTrackText(source.model, 120);
  const capacity = optionalPaymentTrackText(source.capacity, 80);
  const numericQuantity = typeof source.quantity === "string"
    ? Number(source.quantity)
    : typeof source.quantity === "number" ? source.quantity : Number.NaN;
  if ([category, description, model, capacity].some((field) => field === null)
    || (!category && !description && !model)
    || !Number.isSafeInteger(numericQuantity)
    || (numericQuantity as number) < 1
    || (numericQuantity as number) > 10_000) return null;
  return {
    category: category || "Item",
    description: description || model || category || "Item",
    model: model || "",
    capacity: capacity || "",
    quantity: numericQuantity as number,
  };
}

function createInput(body: Record<string, unknown>): CreatePaymentTrackInput | null {
  if (body.actorRole !== "sales") return null;
  const quoteNumber = requiredPaymentTrackText(body.quoteNumber, 80);
  const specialist = specialistValue(body.specialist);
  const customer = customerValue(body.customer);
  const items = Array.isArray(body.items) && body.items.length >= 1 && body.items.length <= 100
    ? body.items.map(itemValue)
    : [];
  const balanceDueCents = paymentTrackAmountToCents(body.balanceDue);
  const expectedDepositCents = body.expectedDeposit === undefined
    || body.expectedDeposit === null
    || body.expectedDeposit === ""
    ? null
    : paymentTrackAmountToCents(body.expectedDeposit);
  if (!quoteNumber || !specialist || !customer || !items.length || items.some((item) => !item)
    || balanceDueCents === null || (body.expectedDeposit !== undefined && body.expectedDeposit !== null
      && body.expectedDeposit !== "" && expectedDepositCents === null)) return null;

  const typedItems = items as Array<Omit<PaymentTrackItem, "id">>;
  const stcSolarRequired = typeof body.stcSolarRequired === "boolean"
    ? body.stcSolarRequired
    : typedItems.some((item) => /solar|panel|inverter/i.test(`${item.category} ${item.description}`));
  const stcBatteryRequired = typeof body.stcBatteryRequired === "boolean"
    ? body.stcBatteryRequired
    : typedItems.some((item) => /battery/i.test(`${item.category} ${item.description}`));
  if (body.solarRebateRequired !== undefined && typeof body.solarRebateRequired !== "boolean") return null;
  const solarRebateRequired = body.solarRebateRequired === true;
  return {
    quoteNumber,
    specialist,
    customer,
    items: typedItems,
    balanceDueCents,
    expectedDepositCents,
    stcSolarRequired,
    stcBatteryRequired,
    solarRebateRequired,
    solarRebateQrRequired: solarRebateRequired,
  };
}

export async function GET(request: NextRequest) {
  try {
    const configuration = paymentTrackAdminConfiguration();
    return paymentTrackJson({
      data: await listPaymentTrackProjects(),
      meta: {
        admin: isPaymentTrackAdmin(request),
        configured: configuration.configured,
        ...(configuration.demoPassword ? { demoPassword: configuration.demoPassword } : {}),
      },
    });
  } catch {
    return paymentTrackError(500, "storage_unavailable", "Project Track records are temporarily unavailable.");
  }
}

export async function POST(request: NextRequest) {
  if (!isAuthorizedMutationRequest(request)) return paymentTrackError(403, "forbidden", "This request is not allowed.");
  if (declaredPaymentTrackBodyTooLarge(request, MAX_JSON_SIZE)) {
    return paymentTrackError(413, "request_too_large", "The project request is too large.");
  }
  try {
    const body = await readPaymentTrackJson(request, MAX_JSON_SIZE);
    if (!isAuthorizedActorRequest(request, "sales")) {
      return paymentTrackError(403, "role_forbidden", "Only Sales or an Administrator can create a project in Project Track.");
    }
    const input = createInput(body);
    if (!input) {
      return paymentTrackError(400, "invalid_project", "Complete the Proposal Number, Sales representative, customer, item and balance information.");
    }
    return paymentTrackJson({ data: await createManualPaymentTrackProject(input) }, { status: 201 });
  } catch (error) {
    if (error instanceof PaymentTrackRepositoryError) return paymentTrackError(error.status, error.code, error.message);
    if (error instanceof PaymentTrackRequestBodyTooLarge) return paymentTrackError(413, "request_too_large", "The project request is too large.");
    if (error instanceof SyntaxError) return paymentTrackError(400, "invalid_json", "The project request is invalid.");
    return paymentTrackError(500, "create_failed", "The project could not be created.");
  }
}

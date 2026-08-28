// @ts-expect-error -- focused Node ESM tests require the explicit extension.
import { optionalPaymentTrackText, paymentTrackAmountToCents, requiredPaymentTrackText } from "./input-validation.ts";
import type {
  PaymentTrackCustomer,
  PaymentTrackItem,
  PaymentTrackSpecialist,
} from "./types";
import type { CreatePaymentTrackInput } from "./repository";

type CreateInputOptions = {
  exact?: boolean;
  deriveStcFlags?: boolean;
};

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOnlyKeys(source: Record<string, unknown>, allowed: ReadonlySet<string>) {
  return Object.keys(source).every((key) => allowed.has(key));
}

const TOP_LEVEL_FIELDS = new Set([
  "actorRole",
  "quoteNumber",
  "specialist",
  "customer",
  "items",
  "balanceDue",
  "expectedDeposit",
  "stcSolarRequired",
  "stcBatteryRequired",
  "solarRebateRequired",
]);
const SPECIALIST_FIELDS = new Set(["name", "phone"]);
const CUSTOMER_FIELDS = new Set([
  "firstName",
  "lastName",
  "phone",
  "email",
  "addressLine1",
  "suburb",
  "state",
  "postcode",
]);
const ITEM_FIELDS = new Set(["category", "description", "model", "capacity", "quantity"]);

function specialistValue(value: unknown, exact: boolean): PaymentTrackSpecialist | null {
  const source = objectValue(value);
  if (!source || (exact && !hasOnlyKeys(source, SPECIALIST_FIELDS))) return null;
  const name = requiredPaymentTrackText(source.name, 120);
  const phone = optionalPaymentTrackText(source.phone, 40);
  return name && phone !== null ? { name, phone } : null;
}

function customerValue(value: unknown, exact: boolean): PaymentTrackCustomer | null {
  const source = objectValue(value);
  if (!source || (exact && !hasOnlyKeys(source, CUSTOMER_FIELDS))) return null;
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

function itemValue(value: unknown, exact: boolean): Omit<PaymentTrackItem, "id"> | null {
  const source = objectValue(value);
  if (!source || (exact && !hasOnlyKeys(source, ITEM_FIELDS))) return null;
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
    || numericQuantity < 1
    || numericQuantity > 10_000) return null;
  return {
    category: category || "Item",
    description: description || model || category || "Item",
    model: model || "",
    capacity: capacity || "",
    quantity: numericQuantity,
  };
}

export function parsePaymentTrackCreateInput(
  body: Record<string, unknown>,
  options: CreateInputOptions = {},
): CreatePaymentTrackInput | null {
  const exact = options.exact === true;
  if (body.actorRole !== "sales" || (exact && !hasOnlyKeys(body, TOP_LEVEL_FIELDS))) return null;
  const quoteNumber = requiredPaymentTrackText(body.quoteNumber, 80);
  const specialist = specialistValue(body.specialist, exact);
  const customer = customerValue(body.customer, exact);
  const items = Array.isArray(body.items) && body.items.length >= 1 && body.items.length <= 100
    ? body.items.map((item) => itemValue(item, exact))
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
  // Keep these gates identical to the proposal parser: Solar STC follows an
  // actual Solar Panel line, not a standalone inverter or incidental wording.
  const derivedSolarRequired = typedItems.some((item) => (
    item.category.toLocaleLowerCase("en-AU").includes("solar panel")
  ));
  const derivedBatteryRequired = typedItems.some((item) => (
    item.category.toLocaleLowerCase("en-AU").includes("battery")
  ));
  const stcSolarRequired = options.deriveStcFlags
    ? derivedSolarRequired
    : typeof body.stcSolarRequired === "boolean" ? body.stcSolarRequired : derivedSolarRequired;
  const stcBatteryRequired = options.deriveStcFlags
    ? derivedBatteryRequired
    : typeof body.stcBatteryRequired === "boolean" ? body.stcBatteryRequired : derivedBatteryRequired;
  if ((exact && typeof body.solarRebateRequired !== "boolean")
    || (body.solarRebateRequired !== undefined && typeof body.solarRebateRequired !== "boolean")
    || (exact && body.stcSolarRequired !== undefined && typeof body.stcSolarRequired !== "boolean")
    || (exact && body.stcBatteryRequired !== undefined && typeof body.stcBatteryRequired !== "boolean")) return null;
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

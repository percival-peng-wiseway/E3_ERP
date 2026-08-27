type InventoryAvailability = {
  category: unknown;
  available: number;
};

function normalizedCategory(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("en-AU")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Solar panels are normally purchased for a specific project and delivered
 * straight to site, so their ERP balance is allowed to represent unreceived
 * supplier stock as a negative number.
 */
export function inventoryCategoryAllowsNegativeStock(category: unknown) {
  return ["太阳能板", "solar panel", "solar panels"].includes(normalizedCategory(category));
}

/** Solar-panel selections are not blocked by warehouse availability. */
export function inventoryItemCanFulfilSelection(
  item: InventoryAvailability | undefined,
  requestedQuantity: number,
) {
  if (!item || !Number.isSafeInteger(requestedQuantity) || requestedQuantity < 1) return false;
  return inventoryCategoryAllowsNegativeStock(item.category) || requestedQuantity <= item.available;
}

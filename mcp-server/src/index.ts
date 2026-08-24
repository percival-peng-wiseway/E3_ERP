#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  getStockStatus,
  withStockStatus,
  type InventoryItemWithStatus,
  type Quotation
} from "./demo-data.js";
import { loadInventoryItems, loadQuotations } from "./data-source.js";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

const stockStatusSchema = z.enum(["in_stock", "low_stock", "out_of_stock"]);
const quotationStatusSchema = z.enum(["draft", "sent", "accepted", "rejected", "expired"]);

const inventoryItemSchema = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  warehouse: z.string(),
  location: z.string(),
  unit: z.string(),
  quantityOnHand: z.number(),
  quantityReserved: z.number(),
  quantityAvailable: z.number(),
  reorderLevel: z.number(),
  unitCost: z.number(),
  currency: z.string(),
  supplier: z.string(),
  lastUpdated: z.string(),
  stockStatus: stockStatusSchema
});

const quotationLineSchema = z.object({
  id: z.string(),
  inventoryItemId: z.string().optional(),
  sku: z.string().optional(),
  name: z.string(),
  quantity: z.number(),
  unit: z.string(),
  unitPrice: z.number(),
  discountPercent: z.number(),
  lineTotal: z.number()
});

const quotationSchema = z.object({
  id: z.string(),
  quotationNumber: z.string(),
  customerId: z.string(),
  customerName: z.string(),
  contactName: z.string(),
  status: quotationStatusSchema,
  issueDate: z.string(),
  validUntil: z.string(),
  currency: z.string(),
  subtotal: z.number(),
  discountTotal: z.number(),
  taxTotal: z.number(),
  grandTotal: z.number(),
  owner: z.string(),
  notes: z.string(),
  items: z.array(quotationLineSchema)
});

function textResult(value: unknown, message?: string) {
  const json = JSON.stringify(value, null, 2);
  return [{ type: "text" as const, text: message ? `${message}\n\n${json}` : json }];
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-AU");
}

function includesText(value: string, query: string): boolean {
  return normalize(value).includes(normalize(query));
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function findInventoryItem(identifier: string): Promise<InventoryItemWithStatus | undefined> {
  const key = normalize(identifier);
  const inventoryItems = await loadInventoryItems();
  const item = inventoryItems.find(
    (candidate) => normalize(candidate.id) === key || normalize(candidate.sku) === key
  );
  return item ? withStockStatus(item) : undefined;
}

async function findQuotation(identifier: string): Promise<Quotation | undefined> {
  const key = normalize(identifier);
  const quotations = await loadQuotations();
  return quotations.find(
    (quotation) =>
      normalize(quotation.id) === key || normalize(quotation.quotationNumber) === key
  );
}

export function createErpMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "erp-inventory-quotation",
      version: "0.1.0"
    },
    {
      instructions:
        "This server is read-only. Use inventory tools for stock questions and quotation tools for sales quotation questions. Call erp_summary for a cross-module overview. Finance and project-management modules are not available yet."
    }
  );

  server.registerTool(
    "inventory_list",
    {
      title: "Inventory List",
      description:
        "List inventory items. Filter by keyword, category, warehouse, and stock status; returns on-hand, reserved, and available quantities plus reorder levels.",
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Keyword matching the item ID, SKU, name, description, or supplier"),
        category: z.string().trim().min(1).optional().describe("Category name; partial matches are supported"),
        warehouse: z.string().trim().min(1).optional().describe("Warehouse name; partial matches are supported"),
        stockStatus: stockStatusSchema.optional().describe("Filter by stock status"),
        limit: z.number().int().min(1).max(100).default(50).describe("Maximum number of results to return")
      },
      outputSchema: {
        count: z.number().int(),
        totalMatched: z.number().int(),
        items: z.array(inventoryItemSchema)
      },
      annotations: readOnlyAnnotations
    },
    async ({ query, category, warehouse, stockStatus, limit }) => {
      const inventoryItems = await loadInventoryItems();
      const matches = inventoryItems.map(withStockStatus).filter((item) => {
        const matchesQuery =
          !query ||
            [item.id, item.sku, item.name, item.description, item.location, item.supplier].some((value) =>
            includesText(value, query)
          );
        const matchesCategory = !category || includesText(item.category, category);
        const matchesWarehouse = !warehouse || includesText(item.warehouse, warehouse);
        const matchesStatus = !stockStatus || item.stockStatus === stockStatus;
        return matchesQuery && matchesCategory && matchesWarehouse && matchesStatus;
      });

      const structuredContent = {
        count: Math.min(matches.length, limit),
        totalMatched: matches.length,
        items: matches.slice(0, limit)
      };

      return {
        content: textResult(structuredContent, `Found ${matches.length} matching inventory items.`),
        structuredContent
      };
    }
  );

  server.registerTool(
    "inventory_get",
    {
      title: "Inventory Details",
      description: "Get inventory details for a single item by inventory ID or full SKU.",
      inputSchema: {
        identifier: z.string().trim().min(1).describe("Inventory ID (for example, item-003) or SKU")
      },
      outputSchema: {
        item: inventoryItemSchema
      },
      annotations: readOnlyAnnotations
    },
    async ({ identifier }) => {
      const item = await findInventoryItem(identifier);
      if (!item) {
        return {
          content: [
            {
              type: "text",
              text: `Inventory item "${identifier}" was not found. Call inventory_list first to find the correct ID or SKU.`
            }
          ],
          isError: true
        };
      }

      const structuredContent = { item };
      return {
        content: textResult(structuredContent, `${item.name} has ${item.quantityAvailable} ${item.unit} available.`),
        structuredContent
      };
    }
  );

  server.registerTool(
    "inventory_low_stock",
    {
      title: "Low Stock Alerts",
      description:
        "List items whose available quantity is at or below the reorder level and calculate the shortage to that level; out-of-stock items are included by default.",
      inputSchema: {
        warehouse: z.string().trim().min(1).optional().describe("Limit results to a warehouse; partial matches are supported"),
        includeOutOfStock: z.boolean().default(true).describe("Include items with zero available quantity"),
        limit: z.number().int().min(1).max(100).default(50).describe("Maximum number of results to return")
      },
      outputSchema: {
        count: z.number().int(),
        items: z.array(
          inventoryItemSchema.extend({
            shortageQuantity: z.number()
          })
        )
      },
      annotations: readOnlyAnnotations
    },
    async ({ warehouse, includeOutOfStock, limit }) => {
      const inventoryItems = await loadInventoryItems();
      const items = inventoryItems
        .map(withStockStatus)
        .filter((item) => {
          const matchesWarehouse = !warehouse || includesText(item.warehouse, warehouse);
          const isLow = item.stockStatus === "low_stock";
          const isIncludedOutOfStock = includeOutOfStock && item.stockStatus === "out_of_stock";
          return matchesWarehouse && (isLow || isIncludedOutOfStock);
        })
        .map((item) => ({
          ...item,
          shortageQuantity: Math.max(item.reorderLevel - item.quantityAvailable, 0)
        }))
        .sort(
          (left, right) =>
            left.quantityAvailable / left.reorderLevel -
            right.quantityAvailable / right.reorderLevel
        )
        .slice(0, limit);

      const structuredContent = { count: items.length, items };
      return {
        content: textResult(structuredContent, `${items.length} inventory items require replenishment attention.`),
        structuredContent
      };
    }
  );

  server.registerTool(
    "quotation_list",
    {
      title: "Quotation List",
      description: "List quotations and filter by keyword, customer, or status; results include total values and expiry dates.",
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Keyword matching the quotation number, customer, contact, owner, or notes"),
        customer: z.string().trim().min(1).optional().describe("Customer ID or name; partial matches are supported"),
        status: quotationStatusSchema.optional().describe("Filter by quotation status"),
        limit: z.number().int().min(1).max(100).default(50).describe("Maximum number of results to return")
      },
      outputSchema: {
        count: z.number().int(),
        totalMatched: z.number().int(),
        quotations: z.array(quotationSchema)
      },
      annotations: readOnlyAnnotations
    },
    async ({ query, customer, status, limit }) => {
      const quotations = await loadQuotations();
      const matches = quotations.filter((quotation) => {
        const matchesQuery =
          !query ||
          [
            quotation.id,
            quotation.quotationNumber,
            quotation.customerName,
            quotation.contactName,
            quotation.owner,
            quotation.notes
          ].some((value) => includesText(value, query));
        const matchesCustomer =
          !customer ||
          includesText(quotation.customerId, customer) ||
          includesText(quotation.customerName, customer);
        const matchesStatus = !status || quotation.status === status;
        return matchesQuery && matchesCustomer && matchesStatus;
      });

      const structuredContent = {
        count: Math.min(matches.length, limit),
        totalMatched: matches.length,
        quotations: matches.slice(0, limit)
      };
      return {
        content: textResult(structuredContent, `Found ${matches.length} matching quotations.`),
        structuredContent
      };
    }
  );

  server.registerTool(
    "quotation_get",
    {
      title: "Quotation Details",
      description: "Get full quotation details by internal ID or complete quotation number.",
      inputSchema: {
        identifier: z.string().trim().min(1).describe("Quotation ID or number, such as QTN-2026-0096")
      },
      outputSchema: {
        quotation: quotationSchema
      },
      annotations: readOnlyAnnotations
    },
    async ({ identifier }) => {
      const quotation = await findQuotation(identifier);
      if (!quotation) {
        return {
          content: [
            {
              type: "text",
              text: `Quotation "${identifier}" was not found. Call quotation_list first to find the correct number.`
            }
          ],
          isError: true
        };
      }

      const structuredContent = { quotation };
      return {
        content: textResult(
          structuredContent,
          `${quotation.quotationNumber}: ${quotation.customerName}, total ${quotation.currency} ${quotation.grandTotal.toFixed(2)}.`
        ),
        structuredContent
      };
    }
  );

  server.registerTool(
    "erp_summary",
    {
      title: "ERP Operations Summary",
      description:
        "Return key metrics and attention items for the enabled inventory and quotation modules, plus modules that are not yet available.",
      inputSchema: {},
      outputSchema: {
        asOf: z.string(),
        currency: z.string(),
        modules: z.object({
          active: z.array(z.string()),
          comingSoon: z.array(z.string())
        }),
        inventory: z.object({
          totalSkus: z.number().int(),
          totalOnHandUnits: z.number(),
          totalAvailableUnits: z.number(),
          lowStockSkus: z.number().int(),
          outOfStockSkus: z.number().int(),
          stockValue: z.number()
        }),
        quotations: z.object({
          total: z.number().int(),
          draft: z.number().int(),
          sent: z.number().int(),
          accepted: z.number().int(),
          rejected: z.number().int(),
          expired: z.number().int(),
          openPipelineValue: z.number(),
          acceptedValue: z.number()
        }),
        attention: z.object({
          lowStock: z.array(
            z.object({
              id: z.string(),
              sku: z.string(),
              name: z.string(),
              quantityAvailable: z.number(),
              reorderLevel: z.number(),
              stockStatus: stockStatusSchema
            })
          ),
          openQuotations: z.array(
            z.object({
              id: z.string(),
              quotationNumber: z.string(),
              customerName: z.string(),
              status: z.enum(["draft", "sent"]),
              validUntil: z.string(),
              grandTotal: z.number()
            })
          )
        })
      },
      annotations: readOnlyAnnotations
    },
    async () => {
      const [inventoryItems, quotations] = await Promise.all([
        loadInventoryItems(),
        loadQuotations()
      ]);
      const inventoryWithStatus = inventoryItems.map(withStockStatus);
      const lowStock = inventoryWithStatus.filter(
        (item) => item.stockStatus === "low_stock" || item.stockStatus === "out_of_stock"
      );
      const openQuotations = quotations.filter(
        (quotation): quotation is Quotation & { status: "draft" | "sent" } =>
          quotation.status === "draft" || quotation.status === "sent"
      );

      const structuredContent = {
        asOf: new Date().toISOString(),
        currency:
          new Set([
            ...inventoryItems.map((item) => item.currency),
            ...quotations.map((quotation) => quotation.currency)
          ]).size === 1
            ? (inventoryItems[0]?.currency ?? quotations[0]?.currency ?? "AUD")
            : "MIXED",
        modules: {
          active: ["inventory", "quotations"],
          comingSoon: ["finance", "project_management"]
        },
        inventory: {
          totalSkus: inventoryItems.length,
          totalOnHandUnits: inventoryItems.reduce((sum, item) => sum + item.quantityOnHand, 0),
          totalAvailableUnits: inventoryItems.reduce(
            (sum, item) => sum + item.quantityAvailable,
            0
          ),
          lowStockSkus: inventoryWithStatus.filter((item) => item.stockStatus === "low_stock")
            .length,
          outOfStockSkus: inventoryWithStatus.filter(
            (item) => item.stockStatus === "out_of_stock"
          ).length,
          stockValue: roundMoney(
            inventoryItems.reduce(
              (sum, item) => sum + item.quantityOnHand * item.unitCost,
              0
            )
          )
        },
        quotations: {
          total: quotations.length,
          draft: quotations.filter((quotation) => quotation.status === "draft").length,
          sent: quotations.filter((quotation) => quotation.status === "sent").length,
          accepted: quotations.filter((quotation) => quotation.status === "accepted").length,
          rejected: quotations.filter((quotation) => quotation.status === "rejected").length,
          expired: quotations.filter((quotation) => quotation.status === "expired").length,
          openPipelineValue: roundMoney(
            openQuotations.reduce((sum, quotation) => sum + quotation.grandTotal, 0)
          ),
          acceptedValue: roundMoney(
            quotations
              .filter((quotation) => quotation.status === "accepted")
              .reduce((sum, quotation) => sum + quotation.grandTotal, 0)
          )
        },
        attention: {
          lowStock: lowStock.map((item) => ({
            id: item.id,
            sku: item.sku,
            name: item.name,
            quantityAvailable: item.quantityAvailable,
            reorderLevel: item.reorderLevel,
            stockStatus: getStockStatus(item)
          })),
          openQuotations: openQuotations.map((quotation) => ({
            id: quotation.id,
            quotationNumber: quotation.quotationNumber,
            customerName: quotation.customerName,
            status: quotation.status,
            validUntil: quotation.validUntil,
            grandTotal: quotation.grandTotal
          }))
        }
      };

      return {
        content: textResult(
          structuredContent,
          `ERP summary: ${inventoryItems.length} inventory SKUs, ${lowStock.length} requiring replenishment attention, and ${openQuotations.length} open quotations.`
        ),
        structuredContent
      };
    }
  );

  return server;
}

async function main(): Promise<void> {
  const server = createErpMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ERP inventory and quotation MCP server is running over stdio.");
}

main().catch((error: unknown) => {
  console.error("Failed to start ERP MCP server:", error);
  process.exitCode = 1;
});

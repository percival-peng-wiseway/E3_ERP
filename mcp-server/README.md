# ERP Inventory & Quotation MCP Server

This is a read-only MCP server for ERP agents. It currently exposes the inventory and quotation modules. Finance and project management are marked as `comingSoon` in the summary, and the server does not provide placeholder query tools for them.

`ERP_WORKSPACE_API_URL` and its matching internal `ERP_WORKSPACE_API_TOKEN` are required. The MCP server reads the connected inventory and quotation applications through the workspace's unified API and fails closed when a live source is unavailable. Because a server-to-server MCP request has no employee browser cookie, the workspace deployment must also configure `ERP_QUOTATION_API_URL` (and `ERP_API_TOKEN` when that source requires one) for MCP quotation tools; the browser-only QuoteHelp session cannot authenticate an MCP process. The old `src/demo-data.ts` file now supplies types and status helpers only; its example records are never loaded by the data source. Every tool has `readOnlyHint: true` and does not modify business data.

## Tools

| Tool | Purpose |
| --- | --- |
| `inventory_list` | Filter inventory by keyword, category, warehouse, or stock status |
| `inventory_get` | Get item details by inventory ID or SKU |
| `inventory_low_stock` | Find low-stock and out-of-stock items with suggested replenishment quantities |
| `quotation_list` | Filter quotations by keyword, customer, or status |
| `quotation_get` | Get complete quotation details by ID or quotation number |
| `erp_summary` | Summarise inventory, quotation pipeline, and attention items |

Every successful result returns both text content and `structuredContent`, making it suitable for natural-language agent answers as well as structured consumption by front ends and other applications.

## Run locally

Node.js 20 or later is required.

```bash
cd mcp-server
npm install
npm run build
npm start
```

Development mode:

```bash
cd mcp-server
npm install
npm run dev
```

Type checking:

```bash
npm run typecheck
```

Tests:

```bash
npm test
```

## MCP client configuration

Run `npm run build`, then add the absolute path to an MCP host that supports stdio:

```json
{
  "mcpServers": {
    "erp-inventory-quotation": {
      "command": "node",
      "args": [
        "/absolute/path/to/ERP/mcp-server/dist/index.js"
      ]
    }
  }
}
```

To use live data from the applications connected to the workspace:

```json
{
  "mcpServers": {
    "erp-inventory-quotation": {
      "command": "node",
      "args": ["/absolute/path/to/ERP/mcp-server/dist/index.js"],
      "env": {
        "ERP_WORKSPACE_API_URL": "http://localhost:3000",
        "ERP_WORKSPACE_API_TOKEN": "the workspace ERP_INTERNAL_API_TOKEN"
      }
    }
  }
}
```

If the workspace API returns a non-2xx response or does not respond within 10 seconds, the MCP server returns an explicit error instead of silently replacing live data with demo data.

You can also inspect and call tools manually with MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Connect a live business system

Prefer adapting existing applications through the workspace's `ERPProvider`, then let the MCP server read the unified data through `ERP_WORKSPACE_API_URL`. This avoids maintaining two field-mapping layers. Keep the MCP layer read-only; if quotation creation or approval is added later, implement separate write tools with explicit destructive and idempotent annotations plus appropriate authorisation checks.

Standard output is reserved for MCP JSON-RPC over stdio. Runtime logs are written only to standard error.

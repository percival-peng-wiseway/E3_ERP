# Unify ERP

An ERPNext-inspired operations workspace that brings Inventory, QuoteHelp, project delivery, payment tracking and employee reimbursements into one native interface.

The application no longer uses iframes. The browser calls same-origin ERP APIs, and controlled server-side proxies connect to the existing Inventory and QuoteHelp services. Existing data, accounts and business rules remain in use.

## Current modules

### Home and Agent

- The Home workspace places the read-only E3 Agent beside the E3 Group internal discussion feed
- DeepSeek answers questions across Inventory, Quotations, Project Management deliveries, Payment Track, Reimbursements and Reports using bounded read-only tools
- Configure the DeepSeek API key, approved model and connection status from Settings; saved UI settings take priority over environment fallbacks
- Only `https://api.deepseek.com` is accepted, with `deepseek-v4-flash` as the default and `deepseek-v4-pro` as the optional model
- Without an API key, basic local summaries remain available
- Payment proof URLs, reimbursement invoice URLs, access tokens, cookies and API keys are never included in model tool results

### Inventory

- Inventory overview, search, categories, status filters and sorting
- Multi-item sales orders that enter Pending PM Review
- Stock receipt parsing and inventory updates
- Completed delivery and stock loss history
- Administrator item editing, stock loss and deletion

### Quotations

- Residential and C&I quotations
- FOX and SIG products with multiple PV, inverter and battery configurations
- Customer details, costs, margins, STCs, rebates, loans and discounts
- Live margin calculations, approval status, save, save as and reset
- Team quotation search, owner, status and date filters
- Product catalogues, user permissions and administrator operations
- Single and bulk Excel export and import

### Project Management

- ERPNext-style delivery Kanban
- Four stages: Pending PM Review, Scheduled, Today and Delivered
- A task appears automatically in Pending PM Review when New Order is submitted in Inventory
- PM users assign the address, date, driver and driver email before scheduling delivery
- Schedule updates continue to use the existing Inventory driver-notification workflow
- Search by customer, address, SKU, sales representative or driver, with driver filtering
- Drag tasks to reschedule them; confirming delivery updates inventory

### Site Visiting

- Create a site visit with the project, address, contact, assignee and scheduled date/time
- Move visits through Scheduled, In Progress, Completed or Cancelled
- Record an extensible on-site checklist, initially covering roof-tile attention and switchboard replacement
- Add checklist notes, general site notes and multiple photos from a phone camera or photo library
- Mobile-first visit cards and a focused on-site detail view for use in the field

### Reimbursements

- Employees submit an AUD amount, expense details and a PDF or image invoice
- New claims enter Admin Review
- Approved claims move to Pending Payment; rejected claims retain the review reason
- Admin records the payment reference and moves paid claims to Reimbursed
- Every claim includes an invoice link and status history
- Local claims are private to the submitting browser; Admin mode can view all claims

### Payment Track

- Sales can import an E3 Solar Proposal PDF or create a project manually
- Proposal import extracts the Specialist, Proposal Number, customer details, system items, expected deposit and printed Balance Due
- Six-stage Kanban: Deposit Not Paid, Material Delivery, Installing, Installed / Waiting COES, STC Rebate and Done
- Specialist uploads deposit proof; Admin confirms the actual amount received, including zero
- Project Managers schedule material delivery, mark delivery and installation complete, and confirm COES receipt
- After delivery, Sales marks the customer payment as received without uploading a file; Admin records the actual amount before installation begins
- Applicable Solar and Battery STC receipts are confirmed separately before completion
- Installed / Waiting COES, STC Rebate and Done projects support repeatable Sales payment acknowledgements followed by Admin amount confirmation; partial or zero receipts remain collectible until the Amount Due reaches zero
- Only the initial deposit requires a payment screenshot or PDF; every successful workflow action closes Project Details
- Cards show the live remaining Amount Due, while Project Details retains the original proposal, every proof and the final-payment ledger

The Sales, Specialist and Project Manager selector models the workflow in this local prototype; only Administrator payment confirmations currently require a protected password session. Do not expose customer or payment data outside a trusted local environment until company SSO supplies the authenticated user and server-enforced role. The production checklist below remains mandatory.

### Reports

- A simple shared needs editor opened from the sidebar footer
- The first line reads “Make life easier，Let me know your needs”
- Users can write requests below it and changes save automatically
- Save status, last-saved time, character count and keyboard save shortcut

Finance remains visible as a disabled future module. The optional MCP implementation remains available for integrations outside the Home Agent.

## Delivery data flow

```text
Inventory New Order
      | submits reserved items and delivery request
      v
Project Management: Pending PM Review
      |
      | PM assigns date and driver
      v
Scheduled / Today
      | confirm delivery
      v
Delivered + Inventory history
```

The project board does not duplicate orders. The Inventory order status is the source of truth: pending orders are awaiting PM review, while scheduled orders appear in Scheduled or Today.

## Local development

Node.js 20 or later is required.

```bash
npm install
npm run dev
```

Open the exact local URL printed by Next.js. The default is `http://localhost:3000`; if that port is occupied, Next.js selects another port such as `http://localhost:3001`.

Production validation:

```bash
npm run typecheck
npm run build
npm start
```

Cloudflare Workers deployment is preconfigured with OpenNext. See [CLOUDFLARE_DEPLOYMENT.md](./CLOUDFLARE_DEPLOYMENT.md) for the GitHub import settings, required secrets and current persistent-storage limitation.

## Service configuration

Copy `.env.example` to `.env.local`. These upstream addresses are server-only and are not included in the browser bundle:

```dotenv
INVENTORY_OPERATIONS_API_URL=https://inventory.e3energy.com.au/api/inventory
QUOTEHELP_APP_URL=https://quote.e3energy.com.au
ERP_INTERNAL_API_TOKEN=
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
AGENT_SETTINGS_DATA_DIR=
GROUP_CHAT_DATA_DIR=
```

- `/api/inventory/operations` accepts only approved Inventory actions and uses a fixed upstream address.
- `/api/quotehelp/*` exposes only the login, session, settings, quotation and import paths used by the native module.
- Both proxies limit body size, connection time and browser request origin.
- Upstream cookies are placed in separate ERP namespaces with restricted paths. ERP, Clerk and other application cookies are never forwarded to external business services.
- Browser writes must be verifiably same-origin. Trusted server writes require the `ERP_INTERNAL_API_TOKEN` bearer token.
- QuoteHelp Excel uploads are limited to 25 MiB; Inventory JSON operations are limited to 512 KiB.
- Agent and Agent Settings writes are same-origin protected and body-size limited. The API key is stored in a private `0700` directory using an atomic `0600` file and is returned only as a masked configured state.
- The DeepSeek connection is restricted to the official HTTPS host. Model tools strictly validate their arguments and return bounded, sanitised, read-only records.

The home summary and retained read-only Agent/MCP APIs can use separate unified data sources:

```dotenv
ERP_INVENTORY_API_URL=
ERP_QUOTATION_API_URL=
ERP_API_TOKEN=
```

When these are empty, the summary uses the included English demo data. This does not affect the native Inventory and QuoteHelp modules.

Reimbursements use local private storage by default:

```dotenv
REIMBURSEMENT_DATA_DIR=
REIMBURSEMENT_ADMIN_PASSWORD=
REIMBURSEMENT_SESSION_SECRET=
REPORTS_DATA_DIR=
PAYMENT_TRACK_DATA_DIR=
PAYMENT_TRACK_ENFORCE_UNIQUE_PROPOSAL=false
SITE_VISIT_DATA_DIR=
```

Local development includes the Admin demo password `admin`. Production requires both an admin password and a separate random session secret of at least 32 characters. Before cloud or multi-server deployment, replace local JSON/file storage with a managed database and private object storage, and connect employee access to the company identity provider.

Payment Track currently allows repeated Proposal Numbers so the same proposal can be uploaded more than once during testing. Set `PAYMENT_TRACK_ENFORCE_UNIQUE_PROPOSAL=true` when testing is complete to restore the duplicate check. Every duplicate still receives its own project ID, `PAY-...` reference and stored contract file.

## Web APIs

| Route | Purpose |
| --- | --- |
| `GET/POST /api/inventory/operations` | Controlled proxy for native Inventory and delivery operations |
| `GET/POST/PUT/DELETE /api/quotehelp/*` | Controlled proxy for native QuoteHelp operations |
| `GET /api/inventory` | Unified read-only inventory list |
| `GET /api/quotations` | Unified read-only quotation list |
| `GET /api/dashboard` | Home inventory, alert and quotation summary |
| `GET/PUT /api/reports` | Load and automatically save the shared needs document |
| `GET/POST/PATCH /api/reimbursements` | Private claim list, invoice submission and admin status actions |
| `GET/POST/DELETE /api/reimbursements/admin` | Reimbursement Admin session |
| `GET /api/reimbursements/:id/invoice` | Protected invoice viewing |
| `GET/POST /api/payment-track` | List projects or create a manual Payment Track project |
| `POST /api/payment-track/import` | Import and extract an E3 Solar Proposal PDF |
| `PATCH /api/payment-track/:id` | Apply an authorised workflow transition |
| `POST /api/payment-track/:id/proof` | Upload the initial deposit proof |
| `GET/POST/DELETE /api/payment-track/admin` | Payment Track Admin session |
| `GET /api/payment-track/:id/files/:fileId` | Protected proposal or proof viewing |
| `GET/POST /api/site-visits` | List and create scheduled site visits |
| `GET/PATCH/DELETE /api/site-visits/:id` | View, update or delete a site visit |
| `POST /api/site-visits/:id/photos` | Upload site photos from a camera or photo library |
| `GET/DELETE /api/site-visits/:id/photos/:photoId` | View or remove a protected site photo |
| `POST /api/agent` | DeepSeek-backed read-only questions across ERP workspaces, with a local fallback |
| `GET/PUT/DELETE /api/settings/agent` | Masked Agent configuration, secure save and environment fallback |

## MCP Server

`mcp-server` retains six read-only tools: inventory list, inventory item, low stock, quotation list, quotation detail and ERP summary. It cannot dispatch, reschedule, delete or confirm delivery.

```bash
cd mcp-server
npm install
npm run build
npm start
```

See `mcp-server/README.md` for details.

## Project structure

```text
src/components/erp-workspace.tsx                  ERPNext-style application shell
src/components/inventory-operations-workspace.tsx Native Inventory module
src/components/quotehelp-workspace.tsx            Native quotation module
src/components/project-delivery-board.tsx         Project delivery Kanban
src/components/payment-track-workspace.tsx        Accounts receivable workflow Kanban
src/components/site-visiting-workspace.tsx        Mobile-first site visit scheduling and field capture
src/components/reimbursement-workspace.tsx        Reimbursements workspace
src/components/reports-workspace.tsx               Auto-saving needs editor
src/app/api/inventory/operations/                 Controlled Inventory proxy
src/app/api/quotehelp/                             Controlled QuoteHelp proxy
src/app/api/reimbursements/                        Claim, admin and invoice APIs
src/app/api/payment-track/                         Payment workflow, import, proof and file APIs
src/app/api/reports/                               Reports document API
src/app/api/settings/agent/                        Secure DeepSeek Agent configuration API
src/lib/agent/                                     DeepSeek client, settings storage and bounded ERP tools
src/lib/payment-track/                             Payment state machine, storage and PDF extraction
src/lib/site-visits/                               Site visit records, checklist and photo storage
src/lib/quotehelp/                                 Quotation domain and Excel logic
src/lib/inventory-operations/                      Inventory types and order grouping
mcp-server/                                        Optional read-only MCP Server
```

## Production security requirements

The current version restores the existing workflows and adds same-origin proxy controls, but it does not yet include a unified ERP identity and role system. Before external production access:

1. Add company SSO or Clerk and define administrator, inventory, sales, PM and reimbursement roles.
2. Enforce organisation and role checks on every write; same-origin checks and hidden buttons are not authorisation.
3. Add CSRF tokens, rate limits, audit logs and operational alerts.
4. Confirm that the upstream Inventory and QuoteHelp cookie policies match the final HTTPS ERP domain.
5. Preserve explicit confirmation and traceability for deletion, stock loss, delivery cancellation and delivery completion.
6. Validate email delivery, Excel import and real stock deductions in a staging environment before switching the production domain.

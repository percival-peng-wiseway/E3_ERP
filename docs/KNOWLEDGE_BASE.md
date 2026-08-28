# Internal knowledge base

## Architecture

Files remains the source of truth. Production file metadata and directories live in
`ERP_DB` (`erp_workspace_files`), while private file bytes live in the existing
`ERP_FILES` Workers KV namespace. Local Node development uses
`.data/workspace-files`. The knowledge base does not introduce R2 and never exposes
KV object keys.

The knowledge pipeline is:

```text
Supported Files upload + signed employee session
  -> server-owned company scope + deterministic default metadata
  -> erp_knowledge_documents + idempotent index job
  -> verified read from ERP_FILES
  -> PDF/DOCX/TXT/Markdown parser
  -> heading/page-aware chunks (central configuration)
  -> one short Markdown item per application chunk in AI Search built-in storage
  -> AI Search hybrid retrieval (vector + BM25, RRF, optional reranker)
  -> server-session ACL and D1 current-version/effective-date/Trash validation
  -> at most eight authorised chunks
  -> existing DeepSeek model produces one grounded answer
  -> server-validated citations point back to the protected Files route
```

AI Search is an index and retrieval service only. The application does not call AI
Search chat completions. Structured ERP records such as projects, customers,
inventory, quotations and payments remain in their existing repositories and Agent
tools.

## Why built-in Items storage

Cloudflare AI Search includes built-in Items storage, so an R2 bucket and R2 service
token are unnecessary. The original Files copy remains authoritative; the short
Markdown Items are disposable search-index material. Deleting the AI Search Items
does not delete the source file.

The application performs structure-aware chunking before upload. Each generated
chunk is kept below the configured AI Search chunk size and is uploaded under a
stable opaque key. Search results are mapped back to `erp_knowledge_chunks`; page,
heading, version, file ID and access metadata therefore come from D1 rather than
from a model-generated citation.

Cloudflare currently limits an AI Search instance to five custom filterable metadata
fields. The instance uses `access_scope`, `category`, `product`, `region` and
`language`. Tenant isolation is enforced by the dedicated E3 instance and is
rechecked against D1 (`tenant_id = 'e3'`). Status, effective dates, current index
generation and Trash state are fail-closed D1 checks before any text reaches the
model.

Official references:

- [AI Search Workers binding](https://developers.cloudflare.com/ai-search/api/search/workers-binding/)
- [Items Workers binding](https://developers.cloudflare.com/ai-search/api/items/workers-binding/)
- [Built-in storage](https://developers.cloudflare.com/ai-search/configuration/data-source/built-in-storage/)
- [Supported document formats and limits](https://developers.cloudflare.com/ai-search/configuration/data-source/)
- [Hybrid search and RRF](https://developers.cloudflare.com/ai-search/configuration/indexing/hybrid-search/)
- [Metadata attributes](https://developers.cloudflare.com/ai-search/configuration/indexing/metadata/)
- [Pre-retrieval filtering](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/)
- [Reranking](https://developers.cloudflare.com/ai-search/configuration/retrieval/reranking/)
- [Bring your own generation model](https://developers.cloudflare.com/ai-search/how-to/bring-your-own-generation-model/)
- [Limits and open-beta pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/)

## Data model and lifecycle

Migration `0005_knowledge_base.sql` adds normalized tables:

- `erp_knowledge_documents`: Files link, metadata, checksum, business version,
  index generation, lifecycle status and errors.
- `erp_knowledge_chunks`: authoritative application chunk text and locators. A
  generation is activated atomically only after every replacement Item indexes.
- `erp_knowledge_index_jobs`: idempotent, leased indexing work with reclaimable
  expired leases and explicit Administrator retry.

Document states are `pending`, `indexing`, `ready`, `failed` and `disabled`.
Search accepts the active generation when the document is `ready`; during a
pending/indexing/failed replacement it may continue serving the prior active
generation, but only while that exact Files checksum/version remains active,
effective, authorised and outside Trash. A replacement generation does not
invalidate the last ready generation until the replacement is complete.

Supported source types are PDF, DOCX, UTF-8 TXT and Markdown. Indexing is bounded
independently from the normal upload request. The first release deliberately limits
knowledge sources to the configured parser size/page/chunk limits; Files may
continue to store larger or unsupported files without indexing them.

Every newly uploaded supported Files document is registered automatically with
`company` access, so every signed-in employee can retrieve it through Agent. The
server derives bounded title/type/category/language/version defaults from the Files
record; an Administrator can refine those settings later. Images, CSV, Excel,
PowerPoint and other unsupported formats remain valid Files items but are labelled
as not indexed. A checksum-identical upload reuses the existing searchable evidence
instead of creating duplicate vectors. A failed knowledge job never rolls back or
misreports the already successful Files upload.

Central runtime parameters are defined only in `src/lib/knowledge/config.ts`:

| Parameter | Value |
| --- | ---: |
| target / minimum / maximum chunk size | 600 / 400 / 800 estimated tokens |
| overlap | 12% |
| source/parser ceiling | 20 MiB, 4,000,000 extracted characters / 250 PDF pages |
| DOCX archive ceiling | 2,048 entries / 32 MiB per entry / 64 MiB expanded total |
| retrieval | maximum 8 chunks, maximum 3 per document, confidence 0.48 |
| controlled background index | maximum 24 chunks, upload concurrency 4 |
| AI Search item poll / job lease | 18 seconds / 45 seconds |

The background path stays within the Worker `after()/waitUntil()` budget. It
uploads at most four items concurrently, then polls the complete document
generation with one AI Search list request per interval and one shared 18-second
deadline. A source producing more than 24 chunks fails with `document_too_large`
before any provider upload. It must be split into smaller approved files until a
durable Queue/Workflow consumer is added. Provider and parser failures enter
`Failed`; an Administrator retries with **Reindex**. Expired running leases are
reclaimable, but this release has no autonomous cron/queue wake-up, so the
UI/manual retry remains the recovery trigger.

## Access scopes

Automatic Files ingestion always assigns `company`. An Administrator may later
choose a narrower scope in Knowledge settings. Scope is never accepted from an
Agent tool call or browser identity claim:

| Scope | Readers |
| --- | --- |
| `company` | Every signed-in employee |
| `sales` | Sales, Specialist and Administrator |
| `pm` | Project Manager and Administrator |
| `finance` | Administrator |
| `admin` | Administrator |

The same server-side check protects Files listing, citation preview/download and
knowledge retrieval. A citation never grants additional file access.

## Cloudflare resource setup

The Worker expects the direct instance binding `KNOWLEDGE_SEARCH` configured in
`wrangler.jsonc`. The instance is intentionally private to the binding; no public AI
Search endpoint or model API key is used by the browser.

Create the instance once in the same Cloudflare account:

```bash
npx wrangler ai-search create erp \
  --type builtin \
  --embedding-model @cf/qwen/qwen3-embedding-0.6b \
  --chunk-size 1024 \
  --chunk-overlap 0 \
  --max-num-results 40 \
  --hybrid-search \
  --reranking \
  --reranking-model @cf/baai/bge-reranker-base \
  --score-threshold 0.35 \
  --custom-metadata access_scope:text \
  --custom-metadata category:text \
  --custom-metadata product:text \
  --custom-metadata region:text \
  --custom-metadata language:text
```

AI Search is in open beta. At the time this architecture was verified, AI Search
storage and vector indexing were included within its published limits, while
Workers AI and AI Gateway usage were billed separately. Confirm the account plan
and budget before enabling production indexing/reranking.

Generate Worker binding types after creating the instance:

```bash
npm run cf-typegen
```

For local Worker-runtime verification, the binding has `remote: true`; AI Search is
not emulated locally. Ordinary Node unit tests inject a bounded fake adapter and do
not silently replace the production search backend.

## Operations

1. Apply D1 migration `0005` before a Worker version that writes knowledge data.
2. Upload a supported Files item. It is registered with `company` access and queued
   automatically; use Administrator Knowledge settings only to refine metadata or
   narrow access.
3. Poll the displayed state until `Ready`; investigate the bounded error code on
   `Failed` and use `Reindex` after correcting the source or service.
4. Moving a file to Trash, disabling it or permanently deleting it makes it
   immediately ineligible in D1. AI Search Item removal is cleanup, not the security
   boundary.
5. A checksum-identical request is idempotent. Metadata or file checksum changes
   create a new index generation.

Active documents are unique by tenant + source checksum. Adding the same bytes
under another Files ID returns `duplicate_checksum`; disabling the canonical copy
releases that active uniqueness slot. Updating one Files record activates the new
generation atomically and retires its prior chunks. Uploading a separate Files item
is not automatically treated as a revision family; administrators must disable the
superseded document unless its checksum is identical.

## Repeatable verification fixture

The repository includes the real two-page PDF
`output/pdf/e3-knowledge-e2e-sop.pdf` (KB-SOP-017, version 2.1). The parser test
verifies both page locators, E117 headings, repeated-footer removal and that its six
chunks fit the controlled indexer. After creating the AI Search instance:

1. Start the application with a signed employee account and upload that PDF in
   Files; wait for its automatic company-scope index to reach `Ready`.
2. As an Administrator, optionally set product `H3 15.0`, region `AU` and effective
   from `2026-08-01`; wait for the metadata reindex to return to `Ready`.
3. Ask Chinese and English E117/216–253V questions and verify title, version, page
   and updated time citations plus protected preview/download.
4. Ask an unsupported question and verify the fixed no-reliable-source response.
5. Repeat with a finance/admin-scoped copy under role-specific sessions and verify
   unauthorised results and citation downloads are both blocked.
6. Run `E3_EVAL_REQUIRE_LIVE=1 npm run eval:business-agent` with signed default,
   Admin, Sales and PM cookies. The runner
   reports Recall@5, citation metadata correctness, grounded-answer proxy,
   no-answer recognition, permission leakage, freshness and latency separately;
   a no-cookie run is explicitly skipped and is not a live RAG result.

Logs contain IDs, states, error classes and timings only. They must not include full
document text, questions, cookies, tokens or model payloads.

## Rollback

To roll back the application without losing Files:

1. Disable knowledge documents or remove the `KNOWLEDGE_SEARCH` binding from the
   rollback Worker version.
2. Keep the D1 tables; older application versions ignore them.
3. AI Search Items can be deleted independently. Source bytes remain in
   `ERP_FILES`.
4. Do not drop migration tables during an incident. A later version can resume or
   reindex from the checksum-tracked Files source.

If search is unavailable, the Agent returns an explicit unavailable/no-reliable-
source response. It must not fall back to uncited model knowledge.

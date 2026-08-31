# Internal knowledge base

## Architecture

Files remains the source of truth. Production file metadata and directories live in
`ERP_DB` (`erp_workspace_files`), while protected file bytes live in `ERP_FILES`.
Vectorize contains only disposable embeddings and bounded metadata; D1 retains the
authoritative chunk text and citation locators.

```text
Supported upload in Files / Knowledge resource
  -> erp_knowledge_documents + idempotent Workflow job
  -> verified read from ERP_FILES
  -> PDF/DOCX/TXT/Markdown parser
  -> heading/page-aware application chunks
  -> Workers AI document embeddings
  -> one 1,024-dimension vector per application chunk in Vectorize
  -> Workers AI query embedding + Vectorize similarity search
  -> D1 current-generation, ACL, effective-date and Trash validation
  -> at most eight authorised chunks
  -> existing DeepSeek model produces a grounded answer
  -> validated citations open the protected Files preview route
```

The application owns chunking, metadata, versioning and access control. It does not
use Cloudflare AI Search. Structured ERP records continue through their existing
repositories and Agent tools.

## Vector design

The Vectorize index is `e3-knowledge`, uses cosine distance, and has 1,024
dimensions. Workers AI model `@cf/qwen/qwen3-embedding-0.6b` generates separate
document and query embeddings. Each D1 chunk maps to one stable vector ID:

```text
knowledge/{document-id}/g{generation}/{zero-padded-chunk-number}
```

Indexed metadata includes tenant, document, generation, chunk number, access scope,
language, category, product and region. Vectorize performs the first candidate
search and filters `access_scope`; the server then resolves every ID against D1 and
rechecks the signed user's role, active generation, source checksum/version,
effective dates and Files Trash state. Vector metadata is never treated as the
security boundary.

Official references:

- [Vectorize Workers binding](https://developers.cloudflare.com/vectorize/get-started/intro/)
- [Vectorize metadata filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/)
- [Workers AI text embeddings](https://developers.cloudflare.com/workers-ai/models/qwen3-embedding-0.6b/)

## Data model and lifecycle

Migration `0005_knowledge_base.sql` provides:

- `erp_knowledge_documents`: Files link, metadata, checksum, business version,
  index generation, lifecycle status and errors.
- `erp_knowledge_chunks`: authoritative chunk text, vector ID and citation locators.
- `erp_knowledge_index_jobs`: idempotent leased jobs with retry support.

States are `pending`, `indexing`, `ready`, `failed` and `disabled`. A replacement
generation is activated atomically only after all vectors are visible. Until then,
the last ready generation may remain searchable only if its exact Files version is
still current and authorised. Partial or timed-out generations are removed from
Vectorize and never activated.

PDF, DOCX, UTF-8 TXT and Markdown are supported. All supported uploads are
registered automatically with `company` access, including uploads made from the
Knowledge resource view. An Administrator may refine title, category, language,
product, region, version, dates and access scope later; that change starts a new
generation. Unsupported formats remain normal Files items without vectors.

Runtime limits are centralised in `src/lib/knowledge/config.ts`:

| Parameter | Value |
| --- | ---: |
| target / minimum / maximum chunk size | 600 / 400 / 800 estimated tokens |
| overlap | 12% |
| source/parser ceiling | 20 MiB, 4,000,000 extracted characters / 250 PDF pages |
| DOCX archive ceiling | 2,048 entries / 32 MiB per entry / 64 MiB expanded total |
| indexing | maximum 256 chunks, embedding batches of 8 |
| embedding / vector format | Qwen3 embedding, 1,024 dimensions, cosine |
| retrieval | 40 vector candidates, maximum 8 chunks, maximum 3 per document |
| local visibility wait / production provider wait | 20 seconds / 2 minutes |
| production Workflow lease | 15 minutes |

Production indexing runs in the durable `e3-knowledge-indexer` Workflow. The HTTP
request schedules the Workflow; parsing, embedding, Vectorize mutation polling and
D1 activation happen outside the upload request. Failures enter `Failed` without
rolling back the successful Files upload. Use **Vectorize again** after correcting
the source or provider condition.

## Access scopes

| Scope | Readers |
| --- | --- |
| `company` | Every signed-in employee |
| `sales` | Sales, Specialist and Administrator |
| `pm` | Project Manager and Administrator |
| `finance` | Administrator |
| `admin` | Administrator |

Only Administrators can open the Knowledge resource management view or change
knowledge settings. Authorised employees may still retrieve knowledge and open a
citation through Agent.

## Cloudflare resource setup

Create the Vectorize index once in the same Cloudflare account as the Worker:

```bash
npx wrangler vectorize create e3-knowledge --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index e3-knowledge --propertyName=access_scope --type=string
```

The second command is required because retrieval applies an `access_scope`
metadata filter. Wait until that metadata index is ready before testing retrieval.
Bindings are declared in `wrangler.jsonc`:

- `AI` — Workers AI embedding inference;
- `KNOWLEDGE_VECTORS` — the `e3-knowledge` Vectorize index;
- `KNOWLEDGE_INDEX_WORKFLOW` — the durable indexing Workflow.

Then generate binding types, migrate and deploy:

```bash
npm run cf-typegen
npm run cf:migrate
npm run deploy
```

No browser key, public Vectorize endpoint or separate Pinecone account is required.
Node tests inject an in-memory provider; Worker preview and production use the
declared Cloudflare bindings.

## Operations

1. Open **Files → Knowledge resource** as an Administrator.
2. Upload a supported file. Upload completion and vectorization are separate; watch
   the selected resource's status in the right inspector.
3. Use **Open preview** to inspect the protected original, or **Vector settings** to
   refine metadata and access.
4. On `Failed`, inspect the bounded error and choose **Vectorize again** after the
   cause is corrected.
5. Moving a source to Trash, disabling it or deleting it makes it immediately
   ineligible in D1. Vector deletion is cleanup, not the access-control boundary.

After migrating from the former AI Search implementation, deploy this version and
run **Vectorize again** once for every existing knowledge document. Old D1 chunk
rows do not prove that the new Vectorize index contains those vectors.

Active sources are unique by tenant and checksum. Metadata or source changes create
a new generation. A checksum-identical active duplicate is rejected; disabling the
canonical copy releases that uniqueness slot.

Health endpoint `GET /api/agent/health` checks D1, Files, Workers AI, Vectorize and
Workflow bindings and verifies an active sample vector when one exists.

## Verification and rollback

```bash
npm run typecheck
npm test
npm run cf:build
```

Use the repository fixture `output/pdf/e3-knowledge-e2e-sop.pdf` for a live upload,
Chinese/English retrieval, protected preview and role-scope check. Logs may include
IDs, states, error classes and timings, but never document text, questions, cookies,
tokens or model payloads.

To roll back without losing Files, disable knowledge retrieval in the rollback
version and keep the D1 tables plus `ERP_FILES`. Vectorize contents can be rebuilt
from the checksum-tracked source later. Do not drop the D1 tables during an
incident; if retrieval is unavailable, Agent must return an explicit unavailable or
no-reliable-source result rather than uncited model knowledge.

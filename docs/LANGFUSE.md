# Langfuse Agent tracing

The ERP Agent uses Langfuse v5 and OpenTelemetry. Tracing is fail-open and is
disabled until it is explicitly enabled. See the official [Langfuse SDK
overview](https://langfuse.com/docs/observability/sdk/overview).

## Configure

Set these server-side values locally in `.env` or `.dev.vars`; never commit the
real values:

```dotenv
LANGFUSE_TRACING_ENABLED=1
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_TRACING_ENVIRONMENT=development
LANGFUSE_RELEASE=
LANGFUSE_CAPTURE_CONTENT=0
LANGFUSE_SESSION_HASH_SALT=
```

Keep `LANGFUSE_CAPTURE_CONTENT=0` in normal development and production. Prompt
and answer text is then represented only by character counts. Raw tool
arguments and results are never exported. Uploaded image bytes and base64 data URLs
are never exported; traces include only attachment and image counts. User IDs are existing opaque
principal hashes; conversation IDs are tenant- and principal-namespaced hashes.

For Cloudflare, put the keys and session salt in Wrangler secrets and expose the
enable flag, base URL, environment, and release as runtime variables. Build and
preview before enabling tracing in production.

## Trace structure

Each chat turn creates one root `agent` observation. Stable child observations
include:

- routing and model attempts as `chain`;
- each model request as `generation`, with standard `input`, `output`, and
  `total` token usage;
- ERP calls as `tool`, and knowledge searches as `retriever`;
- grounding and model-escalation decisions as `guardrail`.

Serverless requests register one best-effort flush through Next.js `after()`.
Exporter failures do not retry or change Agent business operations.

## Run evaluations

Start an authenticated local or preview Agent, configure the role-specific eval
cookies listed by the command below, then run:

```bash
npm run eval:langfuse -- --help
npm run eval:langfuse
```

The runner combines the business-agent and knowledge-RAG suites. Experiment
inputs, expected outputs, and Agent responses are shape-only by default. Set
`LANGFUSE_CAPTURE_CONTENT=1` only for a controlled synthetic run whose content
has been reviewed for upload.

## Release checks

```bash
npm run typecheck
npm test
npm run cf:build
npx wrangler deploy --dry-run
```

Then send one authenticated synthetic Agent request in preview, inspect the
trace hierarchy, token usage, environment, user/session grouping, and masking
in Langfuse, and confirm Agent results are unchanged when tracing is disabled or
the exporter is unavailable. Langfuse ingestion can be eventually consistent,
so allow a short delay before treating a missing child observation as lost.

# Project agent instructions

## Langfuse observability

Install the Langfuse AI skill from `github.com/langfuse/skills` and use it to add tracing to this application with Langfuse following best practices.

- Treat the sentence above as a development-agent instruction. Do not add it to the ERP Agent's runtime system prompts or model conversation context.
- Read the installed Langfuse skill and fetch the current official Langfuse documentation before changing tracing, prompts, datasets, experiments, or evaluations.
- Keep tracing fail-open and privacy-first. Raw ERP prompts and answers must remain excluded unless `LANGFUSE_CAPTURE_CONTENT` is explicitly enabled for a controlled non-production run. Never export raw tool arguments or tool results.
- Run and inspect an end-to-end trace when credentials and an authenticated test path are available. Flush serverless traces before the request lifecycle ends.
- Follow `docs/LANGFUSE.md` for environment, privacy, evaluation, and release checks.

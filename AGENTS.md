# Project agent instructions

## Agent observability

Langfuse is intentionally paused. Do not install its SDKs or add Langfuse tracing,
datasets, experiments, prompts or environment variables unless the user explicitly
requests that it be re-enabled.

- Preserve the application-owned `AgentTrace` and Business Agent structured diagnostics.
- Keep diagnostics privacy-first: never log raw ERP prompts, answers, tool arguments,
  tool results, image/base64 content, cookies, tokens or API keys.
- Keep Cloudflare Workers observability enabled; it is independent of Langfuse.

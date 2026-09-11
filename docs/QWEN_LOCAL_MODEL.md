# Home Qwen model service

The ERP supports Ollama's OpenAI-compatible `/v1/chat/completions` endpoint
behind an authenticated HTTPS tunnel. Both Agent routes and the personal Skill
proposal path use the same server-side configuration. Existing ERP permission,
tool argument, evidence and structured-plan validation remains in force.

## Configure in the ERP

Open **Agent Model Settings**, select **Qwen · Home computer**, and enter the
ngrok HTTPS address, exact Ollama model name, Basic Auth username and password.
For an unconfigured ERP this form is selected by default. Click **Verify & Save
Qwen**. Only administrators may save these settings.

Before saving, the server checks the authenticated `/v1/models` response for the
selected model. This verifies connectivity and model availability, not inference
quality or speed. Failed validation leaves the current settings unchanged.
The saved password is never returned to the browser. Leave it blank to retain it
only when the address and username are unchanged; a changed address or username
requires a new password. Browser-saved addresses must be ngrok HTTPS domains;
custom domains use the environment configuration below.

Local development saves to the existing private Agent settings directory. Cloudflare
uses the existing database settings document. To switch back, select Kimi and
save its settings. Choosing Kimi replaces the saved Qwen connection.

## Server-managed configuration (optional)

First verify the model on the Windows computer using an up-to-date Ollama:

```powershell
ollama run qwen3.5:9b
```

Configure these values on the ERP server (Cloudflare Worker secrets in production;
`.env.local` in local development):

- `AGENT_MODEL_PROVIDER`: `ollama`
- `QWEN_BASE_URL`: the verified tunnel HTTPS origin, optionally ending in `/v1`
- `QWEN_MODEL_NAME`: exact installed model name, initially `qwen3.5:9b`
- `QWEN_BASIC_AUTH_USER`: the ngrok Basic Auth username
- `QWEN_BASIC_AUTH_PASSWORD`: its password, not the ngrok account authtoken

For production, use the Cloudflare dashboard or interactive `wrangler secret put`
commands. Never put passwords in source, frontend variables, command arguments,
chat, logs or committed configuration. Set endpoint, model and credentials before
setting `AGENT_MODEL_PROVIDER=ollama`. Deploy the supporting code before activation.

An explicit Ollama selection overrides saved Kimi settings. Invalid or missing
Qwen configuration fails closed; requests do not silently fall back to Moonshot.
When the environment override is enabled, the settings dialog displays Qwen as server-managed and does not return credentials.
A configured indicator does not prove the endpoint is currently online.

## Verify before production use

Check `/api/tags` and `/v1/models` through the authenticated tunnel, then exercise:

1. A short text response and a single image request.
2. A structured query plan using the ERP's actual response schema.
3. A read-only ERP tool request, its result, and a grounded final answer.
4. An unauthenticated request, a wrong password, and a stopped tunnel.

Use synthetic inputs for initial connectivity testing. Do not log prompts,
answers, tool arguments/results, base64 images or credentials. Keep the existing
privacy-preserving AgentTrace diagnostics and Cloudflare observability enabled.
Langfuse remains paused.

Ollama requests use Basic Auth, `max_tokens`, and `reasoning_effort=none`.
Each model call allows up to 120 seconds for cold startup; the legacy Business
Agent has a 300-second total budget. These are upper bounds, not a speed guarantee.

The ERP planning catalog and tool results can exceed a standalone chat's 4K
context. Set an adequate context on the Windows Ollama service and measure GPU
memory use using actual ERP requests. Start by testing 8K, then increase only if
needed and feasible. Do not assume model-advertised maximum context fits 12GB VRAM.

For an ongoing deployment expose only inference routes through an authenticated
local gateway; direct authenticated Ollama tunneling is for initial private testing.
Disable request/body capture in tunnel inspection tools for ERP data.

## Rollback

For an environment-managed connection, remove the Ollama environment override to
return to saved settings. For a browser-saved connection, select Kimi in the dialog
and verify/save its settings. Qwen request failures never trigger a provider switch.

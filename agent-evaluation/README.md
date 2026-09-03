# E3 Agent evaluation workspace

This directory owns the repeatable evaluation process and privacy-safe result summaries for the E3 Agent. It does not store raw ERP prompts, answers, tool arguments, tool results, image content, cookies or credentials.

## Evaluation flow

1. Validate every registered evaluation dataset and count its cases.
2. Run TypeScript validation.
3. Run all tests under `src/lib/erp_agent/agent`.
4. Optionally run the complete repository suite and a production build.
5. Optionally call the signed-in staging/local Agent against read-only cloud data.
6. Write aggregate results to `results/latest.json`, `results/latest.md` and a timestamped JSON record.

The release gates are defined in `evaluation-manifest.json`. Security gates are absolute: permission leaks and write operations must remain zero.

## Commands

Run the local Agent gate from Windows PowerShell or the Codex terminal. This launcher automatically finds the bundled Node.js runtime and does not require `npm` to be on `PATH`:

```powershell
.\agent-evaluation\run.ps1
```

Include all repository tests and a Next.js production build:

```powershell
.\agent-evaluation\run.ps1 -Full -Build
```

Run against signed-in, read-only cloud data:

```powershell
$env:E3_EVAL_BASE_URL = "http://localhost:3000"
$env:E3_EVAL_COOKIE = "<signed-in session cookie>"
$env:E3_EVAL_ADMIN_COOKIE = "<administrator session cookie>"
$env:E3_EVAL_SALES_COOKIE = "<sales session cookie>"
$env:E3_EVAL_PM_COOKIE = "<project-manager session cookie>"
$env:E3_EVAL_REQUIRE_LIVE = "1"
.\agent-evaluation\run.ps1 -Live
```

CI or terminals with a standard Node/npm installation may use `npm run eval:e3-agent` and append runner flags after `--`.

Never commit the Cookie or place it in a result file. The live run currently executes both `/api/agent` trajectory cases and the retained `/api/agent/chat` business/knowledge regression datasets. As the knowledge cases migrate to the main endpoint, update only the manifest and runner rather than creating another evaluation path.

## Interpreting results

- A local run must pass before changing Prompt, routing, Tool Registry, Skills or Memory.
- Run live evaluation before staging/production promotion.
- Change one variable at a time and compare the generated aggregate reports.
- A result with better answer quality but worse permission, grounding or abstention behaviour must not be promoted.

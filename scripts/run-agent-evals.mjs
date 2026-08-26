import { readFile } from "node:fs/promises";

const baseUrl = (process.env.E3_EVAL_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const cookie = process.env.E3_EVAL_COOKIE || "";
const cases = JSON.parse(await readFile(new URL("../evals/agent-business.json", import.meta.url), "utf8"));
let failed = 0;

for (const entry of cases) {
  const response = await fetch(`${baseUrl}/api/agent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ message: entry.query, history: [] }),
  });
  const payload = await response.json().catch(() => ({}));
  const workflow = payload?.data?.workflow;
  const tracedWorkflow = payload?.meta?.trace?.workflow;
  const passed = response.ok
    && workflow === entry.expectedWorkflow
    && payload?.data?.mode === "local"
    && typeof payload?.data?.answer === "string";
  if (!passed) failed += 1;
  const traceNote = tracedWorkflow && tracedWorkflow !== workflow
    ? `, trace selected ${tracedWorkflow}`
    : "";
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${entry.name} (${response.status}, response ${workflow || "no deterministic workflow"}${traceNote})\n`);
}

if (failed) {
  process.stderr.write(`${failed} business eval(s) failed.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`All ${cases.length} live business evals passed.\n`);
}

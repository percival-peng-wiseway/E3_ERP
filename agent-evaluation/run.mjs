import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const evaluationDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(evaluationDirectory, "..");
const resultsDirectory = join(evaluationDirectory, "results");
const manifestPath = join(evaluationDirectory, "evaluation-manifest.json");
const flags = new Set(process.argv.slice(2));
const includeLive = flags.has("--live");
const includeFullSuite = flags.has("--full");
const includeBuild = flags.has("--build");

function runProcess(name, executable, args, options = {}) {
  return new Promise((complete) => {
    const startedAt = performance.now();
    process.stdout.write(`\n[${name}]\n`);
    const child = spawn(executable, args, {
      cwd: projectDirectory,
      env: process.env,
      stdio: "inherit",
      shell: false,
      ...options,
    });
    child.once("error", () => complete({
      name,
      status: "failed",
      exitCode: null,
      durationMs: Math.round(performance.now() - startedAt),
    }));
    child.once("exit", (code) => complete({
      name,
      status: code === 0 ? "passed" : "failed",
      exitCode: code,
      durationMs: Math.round(performance.now() - startedAt),
    }));
  });
}

function safeRunId(date) {
  return date.toISOString().replaceAll(":", "-").replace(".", "-");
}

function markdownReport(result) {
  const rows = result.steps.map((step) => (
    `| ${step.name} | ${step.status} | ${step.exitCode ?? "—"} | ${step.durationMs} ms |`
  ));
  const datasets = result.datasets.map((dataset) => (
    `| ${dataset.id} | ${dataset.caseCount} | ${dataset.status} | \`${dataset.path}\` |`
  ));
  return [
    "# E3 Agent evaluation result",
    "",
    `- Run: \`${result.runId}\``,
    `- Status: **${result.status}**`,
    `- Scope: ${result.scope.join(", ")}`,
    `- Started: ${result.startedAt}`,
    `- Finished: ${result.finishedAt}`,
    "- Privacy: no raw prompts, answers, tool arguments, tool results or secrets were stored.",
    "",
    "## Steps",
    "",
    "| Step | Status | Exit | Duration |",
    "|---|---|---:|---:|",
    ...rows,
    "",
    "## Datasets",
    "",
    "| Dataset | Cases | Status | Source |",
    "|---|---:|---|---|",
    ...datasets,
    "",
    "## Release gates",
    "",
    "```json",
    JSON.stringify(result.releaseGates, null, 2),
    "```",
    "",
    result.notes.length ? `Notes: ${result.notes.join(" ")}` : "Notes: none.",
    "",
  ].join("\n");
}

const started = new Date();
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const datasets = [];
for (const dataset of manifest.datasets) {
  const absolutePath = resolve(projectDirectory, dataset.path);
  if (!absolutePath.startsWith(projectDirectory)) throw new Error("Evaluation dataset escaped the project directory.");
  const cases = JSON.parse(await readFile(absolutePath, "utf8"));
  if (!Array.isArray(cases) || cases.length === 0) throw new Error(`Evaluation dataset is empty: ${dataset.id}`);
  datasets.push({
    id: dataset.id,
    path: relative(projectDirectory, absolutePath).replaceAll("\\", "/"),
    caseCount: cases.length,
    status: includeLive ? "scheduled for live scoring" : "validated only",
  });
}

const steps = [];
steps.push(await runProcess(
  "TypeScript",
  process.execPath,
  [join(projectDirectory, "node_modules", "typescript", "bin", "tsc"), "--noEmit"],
));
steps.push(await runProcess(
  "Agent tests",
  process.execPath,
  ["--experimental-strip-types", "--test", "src/lib/erp_agent/agent/*.test.ts"],
));

if (includeFullSuite) {
  steps.push(await runProcess(
    "Full repository tests",
    process.execPath,
    ["--experimental-strip-types", "--test", "src/lib/**/*.test.ts"],
  ));
}
if (includeBuild) {
  steps.push(await runProcess(
    "Next.js production build",
    process.execPath,
    [join(projectDirectory, "node_modules", "next", "dist", "bin", "next"), "build"],
  ));
}
if (includeLive) {
  if (!process.env.E3_EVAL_COOKIE) {
    steps.push({
      name: "Live read-only evaluation",
      status: "blocked",
      exitCode: null,
      durationMs: 0,
    });
    for (const dataset of datasets) dataset.status = "live scoring blocked: no session";
  } else {
    const liveMainResult = await runProcess(
      "Live main Agent trajectory",
      process.execPath,
      [join(projectDirectory, "scripts", "run-agent-evals.mjs")],
    );
    const liveRegressionResult = await runProcess(
      "Live business and knowledge regression",
      process.execPath,
      [join(projectDirectory, "scripts", "run-business-agent-evals.mjs")],
    );
    steps.push(liveMainResult, liveRegressionResult);
    const liveStatus = liveMainResult.status === "passed" && liveRegressionResult.status === "passed"
      ? "live scoring passed"
      : "live scoring failed";
    for (const dataset of datasets) dataset.status = liveStatus;
  }
}

const finished = new Date();
const nonPassingSteps = steps.filter((step) => step.status !== "passed");
const result = {
  schemaVersion: 1,
  runId: safeRunId(started),
  status: nonPassingSteps.length ? "failed" : "passed",
  startedAt: started.toISOString(),
  finishedAt: finished.toISOString(),
  scope: ["local-agent", ...(includeFullSuite ? ["full-suite"] : []), ...(includeBuild ? ["build"] : []), ...(includeLive ? ["live-read-only"] : [])],
  environment: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  privacy: manifest.privacy,
  datasets,
  releaseGates: manifest.releaseGates,
  steps,
  notes: [
    ...(!includeLive ? ["Live dataset scoring was not run. Use --live with a signed-in read-only session."] : []),
    ...(nonPassingSteps.length
      ? [`Non-passing steps: ${nonPassingSteps.map((step) => step.name).join(", ")}. Review console output; raw output is not copied into result files.`]
      : []),
  ],
};

await mkdir(resultsDirectory, { recursive: true });
await Promise.all([
  writeFile(join(resultsDirectory, `${result.runId}.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8"),
  writeFile(join(resultsDirectory, "latest.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8"),
  writeFile(join(resultsDirectory, "latest.md"), markdownReport(result), "utf8"),
]);
process.stdout.write(`\nEvaluation ${result.status}. Result: agent-evaluation/results/latest.md\n`);
if (nonPassingSteps.length) process.exitCode = 1;

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const projectRoot = process.cwd();
const dataRoot = path.join(projectRoot, ".data");
const paymentRoot = path.join(dataRoot, "payment-track");
const scheduleRoot = path.join(dataRoot, "project-schedule");
const siteVisitRoot = path.join(dataRoot, "site-visits");
const storedFilePattern = /^[0-9a-f-]{36}\.(?:pdf|jpg|png|webp)$/i;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const documentKeys = [
  "payment-track/records",
  "project-schedule/records",
  "site-visits/records",
];

if (!process.argv.includes("--confirm-sensitive-upload")) {
  throw new Error(
    "This command uploads private customer records and files. Re-run with --confirm-sensitive-upload after confirming the Cloudflare destination.",
  );
}

function runWrangler(argumentsList) {
  const result = spawnSync("npx", ["wrangler", ...argumentsList], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(`Wrangler command failed with exit status ${result.status ?? "unknown"}.`);
  }
  return result.stdout;
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function readJsonArray(filePath, label) {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    if (!Array.isArray(value)) throw new Error(`${label} records must be a JSON array.`);
    return value;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return [];
    throw error;
  }
}

function assertProductionDocumentsAreAbsent() {
  const list = documentKeys.map(sqlText).join(", ");
  const output = runWrangler([
    "d1", "execute", "e3-erp-prod", "--remote",
    "--command", `SELECT key FROM erp_documents WHERE key IN (${list})`,
    "--json",
  ]);
  const payload = JSON.parse(output);
  const existing = Array.isArray(payload)
    ? payload.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : [])
      .map((row) => row?.key)
      .filter((key) => typeof key === "string")
    : [];
  if (existing.length) {
    throw new Error(
      `Production data already exists for ${existing.join(", ")}. Migration stopped before uploading files.`,
    );
  }
}

function paymentFiles(projects) {
  const files = [];
  for (const project of projects) {
    files.push(project?.contract, project?.deposit?.proof, project?.collection?.proof);
    for (const payment of project?.finalPayments || []) files.push(payment?.proof);
  }
  return files.filter(Boolean);
}

function remapPaymentFiles(projects, uploads) {
  for (const file of paymentFiles(projects)) {
    const originalStoredName = file.storedName;
    if (!storedFilePattern.test(originalStoredName) || path.basename(originalStoredName) !== originalStoredName) {
      throw new Error("A Project Track record contains an unsafe stored filename.");
    }
    const directory = file.kind === "contract" ? "contracts" : "proofs";
    const extension = path.extname(originalStoredName).toLowerCase();
    const newStoredName = `${randomUUID()}${extension}`;
    uploads.push({
      key: `payment-track/${directory}/${newStoredName}`,
      source: path.join(paymentRoot, directory, originalStoredName),
      expectedSize: file.size,
    });
    file.storedName = newStoredName;
  }
}

function remapSiteVisitPhotos(visits, uploads) {
  for (const visit of visits) {
    if (!idPattern.test(visit?.id)) throw new Error("A Site Visiting record contains an invalid ID.");
    for (const photo of visit?.photos || []) {
      const originalStoredName = photo.storedName;
      if (!storedFilePattern.test(originalStoredName) || path.basename(originalStoredName) !== originalStoredName) {
        throw new Error("A Site Visiting record contains an unsafe stored filename.");
      }
      const extension = path.extname(originalStoredName).toLowerCase();
      const newStoredName = `${randomUUID()}${extension}`;
      uploads.push({
        key: `site-visits/photos/${visit.id}/${newStoredName}`,
        source: path.join(siteVisitRoot, "photos", visit.id, originalStoredName),
        expectedSize: photo.size,
      });
      photo.storedName = newStoredName;
    }
  }
}

assertProductionDocumentsAreAbsent();

const paymentProjects = structuredClone(await readJsonArray(
  path.join(paymentRoot, "records.json"),
  "Project Track",
));
const scheduleJobs = await readJsonArray(path.join(scheduleRoot, "records.json"), "Project Schedule");
const siteVisits = structuredClone(await readJsonArray(path.join(siteVisitRoot, "records.json"), "Site Visiting"));
const uploads = [];
remapPaymentFiles(paymentProjects, uploads);
remapSiteVisitPhotos(siteVisits, uploads);

for (const upload of uploads) {
  const fileStat = await stat(upload.source);
  if (Number.isSafeInteger(upload.expectedSize) && upload.expectedSize !== fileStat.size) {
    throw new Error("A private file does not match the size recorded in its local metadata.");
  }
}

for (const upload of uploads) {
  runWrangler([
    "kv", "key", "put", upload.key,
    "--path", upload.source,
    "--binding", "ERP_FILES",
    "--remote",
  ]);
}

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "e3-erp-d1-import-"));
const sqlPath = path.join(temporaryDirectory, "import.sql");
try {
  const timestamp = new Date().toISOString();
  const documents = [
    ["payment-track/records", paymentProjects],
    ["project-schedule/records", scheduleJobs],
    ["site-visits/records", siteVisits],
  ];
  const statements = documents.map(([key, value]) => (
    `INSERT INTO erp_documents (key, value, version, updated_at) VALUES (`
      + `${sqlText(key)}, ${sqlText(JSON.stringify(value))}, 1, ${sqlText(timestamp)});`
  ));
  await writeFile(sqlPath, `${statements.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(sqlPath, 0o600);
  runWrangler(["d1", "execute", "e3-erp-prod", "--remote", "--file", sqlPath]);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log(
  `Imported ${paymentProjects.length} Project Track project(s), `
    + `${scheduleJobs.length} Project Schedule job(s), ${siteVisits.length} Site Visit(s), `
    + `and ${uploads.length} private file(s).`,
);

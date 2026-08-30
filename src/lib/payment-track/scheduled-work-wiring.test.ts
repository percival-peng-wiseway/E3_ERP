import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const [workspaceSource, boardSource, boardStyleSource] = await Promise.all([
  readFile(new URL("../../components/erp-workspace.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../components/project-delivery-board.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../components/project-delivery-board.module.css", import.meta.url), "utf8"),
]);

function sourceBetween(source: string, start: RegExp, end: RegExp) {
  const startMatch = start.exec(source);
  assert.ok(startMatch?.index !== undefined, `missing source section start: ${start}`);
  const bodyStart = startMatch.index + startMatch[0].length;
  const endMatch = end.exec(source.slice(bodyStart));
  assert.ok(endMatch?.index !== undefined, `missing source section end: ${end}`);
  return source.slice(bodyStart, bodyStart + endMatch.index);
}

test("the Weekly Schedule navigation badge uses the shared WIP-unscheduled selector", () => {
  assert.match(
    workspaceSource,
    /import \{ countWipUnscheduledPaymentTrackProjects \} from "@\/lib\/payment-track\/wip-unscheduled-work";/,
  );
  assert.match(
    workspaceSource,
    /setWipUnscheduledProjectCount\(countWipUnscheduledPaymentTrackProjects\(paymentBody\.data\)\);/,
  );
  assert.doesNotMatch(workspaceSource, /countScheduledIncompletePaymentTrackProjects|scheduledIncompleteProjectCount/);

  const badgeLoader = sourceBetween(
    workspaceSource,
    /async function loadWipUnscheduledProjectCount\(\) \{/,
    /\n    const refresh =/,
  );
  assert.match(badgeLoader, /fetch\("\/api\/payment-track", \{ cache: "no-store" \}\)/);
  assert.doesNotMatch(badgeLoader, /\/api\/project-schedule|overrides|inventory/);
});

test("the Weekly Schedule badge renders a confirmed zero and has accurate accessible copy", () => {
  assert.match(
    workspaceSource,
    /item\.id === "projects" && wipUnscheduledProjectCount !== null && \(/,
    "zero is a valid confirmed count and must not hide the badge",
  );
  assert.match(
    workspaceSource,
    /\{wipUnscheduledProjectCount > 99 \? "99\+" : wipUnscheduledProjectCount\}/,
  );
  assert.match(workspaceSource, /Working in Progress.*unscheduled/);
  assert.doesNotMatch(
    workspaceSource,
    /item\.id === "projects" && wipUnscheduledProjectCount > 0/,
  );
});

test("the WIP badge refreshes from Project Track changes only", () => {
  const badgeEffect = sourceBetween(
    workspaceSource,
    /async function loadWipUnscheduledProjectCount\(\) \{/,
    /\n  \}, \[\]\);/,
  );
  assert.match(badgeEffect, /window\.addEventListener\("erp:payment-track-updated", refresh\)/);
  assert.match(badgeEffect, /window\.removeEventListener\("erp:payment-track-updated", refresh\)/);
  assert.doesNotMatch(badgeEffect, /erp:project-schedule-updated/);
});

test("the calendar rail is a global Project Track WIP-unscheduled queue", () => {
  assert.match(
    boardSource,
    /import \{ wipUnscheduledPaymentTrackProjects \} from "@\/lib\/payment-track\/wip-unscheduled-work";/,
  );
  const selectorMemo = sourceBetween(
    boardSource,
    /const wipUnscheduledProjects = useMemo\(\(\) => \{/,
    /\n  const wipUnscheduledReady =/,
  );
  assert.match(selectorMemo, /wipUnscheduledPaymentTrackProjects\(projects\)/);
  assert.doesNotMatch(selectorMemo, /weekStart|weekEnd|filter|visibleEntries|sourceOverride/);
  assert.match(selectorMemo, /\}, \[paymentSourceReady, projects\]\);/);
  assert.match(boardSource, /<strong id="schedule-rail-title">WIP · Unscheduled<\/strong>/);
  assert.doesNotMatch(boardSource, /ScheduleRailView|railView|Scheduled · Not completed/);
});

test("calendar rail cards navigate to the exact Project Track project", () => {
  assert.match(
    workspaceSource,
    /onOpenProjectTrackProject=\{\(projectId\) => navigate\("payments", true, projectId\)\}/,
  );
  assert.match(boardSource, /onOpenProjectTrackProject\?: \(projectId: string\) => void;/);
  assert.match(
    boardSource,
    /<li key=\{unscheduled\.projectId\} className=\{styles\.scheduledProjectItem\}>[\s\S]*?<button[\s\S]*?onClick=\{\(\) => onOpenProjectTrackProject\?\.\(unscheduled\.projectId\)\}/,
  );
  assert.match(boardSource, /Open Project Track <ChevronRight/);
});

test("the list view preserves distinct legacy pending work without duplicating WIP", () => {
  assert.match(
    boardSource,
    /visibleUnscheduled\.filter\(\(entry\) => entry\.project\.stage !== "working_in_progress"\)/,
  );
  assert.match(boardSource, /<h2 id="unscheduled-title">Pending Schedule<\/h2>/);
  assert.match(boardSource, /visibleLegacyPending\.map\(renderUnscheduledEntry\)/);
});

test("the compact calendar rail header no longer reserves space for queue tabs", () => {
  assert.match(
    boardStyleSource,
    /\.unscheduledRail > header\s*\{[\s\S]*?min-height:\s*55px;/,
  );
  assert.doesNotMatch(boardStyleSource, /\.scheduleRailTabs|\.activeScheduleRailTab/);
  assert.match(
    boardStyleSource,
    /\.scheduledRailProjectList\s*\{[\s\S]*?flex-direction:\s*column;/,
  );
});

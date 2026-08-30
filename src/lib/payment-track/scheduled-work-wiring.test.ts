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

test("the Weekly Schedule navigation badge uses the shared scheduled-incomplete selector", () => {
  assert.match(
    workspaceSource,
    /import \{ countScheduledIncompletePaymentTrackProjects \} from "@\/lib\/payment-track\/scheduled-work";/,
  );
  assert.match(
    workspaceSource,
    /setScheduledIncompleteProjectCount\(countScheduledIncompletePaymentTrackProjects\(\s*paymentBody\.data,\s*scheduleBody\.data\.overrides as ProjectScheduleSourceOverride\[\],\s*\)\);/,
  );
  assert.doesNotMatch(workspaceSource, /pendingPmReviewCount|setPendingPmReviewCount/);

  const badgeLoader = sourceBetween(
    workspaceSource,
    /async function loadScheduledIncompleteProjectCount\(\) \{/,
    /\n    const refresh =/,
  );
  assert.match(badgeLoader, /fetch\("\/api\/payment-track", \{ cache: "no-store" \}\)/);
  assert.match(badgeLoader, /fetch\(`\/api\/project-schedule\?from=/);
  assert.doesNotMatch(badgeLoader, /\/api\/inventory\/operations|groupOrders|pending PM review/i);
});

test("the Weekly Schedule badge renders a confirmed zero and refreshes after schedule overrides", () => {
  assert.match(
    workspaceSource,
    /item\.id === "projects" && scheduledIncompleteProjectCount !== null && \(/,
    "zero is a valid confirmed count and must not hide the badge",
  );
  assert.match(
    workspaceSource,
    /\{scheduledIncompleteProjectCount > 99 \? "99\+" : scheduledIncompleteProjectCount\}/,
  );
  assert.doesNotMatch(
    workspaceSource,
    /item\.id === "projects" && scheduledIncompleteProjectCount > 0/,
  );
  assert.match(
    workspaceSource,
    /window\.addEventListener\("erp:project-schedule-updated", refresh\)/,
  );
  assert.match(
    workspaceSource,
    /window\.removeEventListener\("erp:project-schedule-updated", refresh\)/,
  );
});

test("scheduled cards navigate to the exact Project Track project", () => {
  assert.match(
    workspaceSource,
    /onOpenProjectTrackProject=\{\(projectId\) => navigate\("payments", true, projectId\)\}/,
  );
  assert.match(boardSource, /onOpenProjectTrackProject\?: \(projectId: string\) => void;/);
  assert.match(
    boardSource,
    /<li key=\{scheduled\.projectId\} className=\{styles\.scheduledProjectItem\}>[\s\S]*?<button[\s\S]*?className=\{styles\.scheduledProjectCard\}[\s\S]*?onClick=\{\(\) => onOpenProjectTrackProject\?\.\(scheduled\.projectId\)\}/,
  );
  assert.match(boardSource, /Open Project Track <ChevronRight/);
});

test("the global scheduled-incomplete rail is independent of the selected week and filter", () => {
  assert.match(
    boardSource,
    /import \{ scheduledIncompletePaymentTrackProjects \} from "@\/lib\/payment-track\/scheduled-work";/,
  );
  const selectorMemo = sourceBetween(
    boardSource,
    /const scheduledIncompleteProjects = useMemo\(\(\) => \{/,
    /\n  const scheduledIncompleteReady =/,
  );
  assert.match(
    selectorMemo,
    /scheduledIncompletePaymentTrackProjects\(projects, sourceOverrideState\)/,
  );
  assert.doesNotMatch(selectorMemo, /weekStart|weekEnd|filter|visibleEntries|visibleUnscheduled/);
  assert.match(
    selectorMemo,
    /\}, \[paymentSourceReady, projects, sourceOverrideState, sourceOverridesReady\]\);/,
  );
  assert.match(boardSource, /<small>All dates<\/small>/);
});

test("the calendar rail defaults to scheduled work, preserves Pending Schedule, and waits for both source datasets", () => {
  assert.match(
    boardSource,
    /const \[railView, setRailView\] = useState<ScheduleRailView>\("scheduled"\);/,
  );
  assert.match(
    boardSource,
    /id="pending-projects-rail-tab"[\s\S]*?onClick=\{\(\) => setRailView\("pending"\)\}/,
  );
  assert.match(
    boardSource,
    /<h2 id="unscheduled-title">Pending Schedule<\/h2><span>\{visibleUnscheduled\.length\}<\/span>/,
  );
  assert.match(
    boardSource,
    /if \(!paymentSourceReady \|\| !sourceOverridesReady\) return \[\];/,
  );
  assert.match(
    boardSource,
    /const scheduledIncompleteReady = paymentSourceReady && sourceOverridesReady;/,
  );
  assert.match(
    boardSource,
    /scheduledIncompleteReady \? scheduledIncompleteProjects\.length : "—"/,
  );
});

test("the calendar-aligned rail exposes a visible header, global count, and one button card per project", () => {
  assert.match(boardSource, /aria-labelledby="schedule-rail-title"/);
  assert.match(
    boardSource,
    /<strong id="schedule-rail-title">\{railView === "scheduled" \? "Scheduled · Not completed" : "Pending Schedule"\}<\/strong>/,
  );
  assert.match(boardSource, /scheduledIncompleteProjects\.map\(renderScheduledIncompleteProject\)/);
  assert.match(boardSource, /renderScheduledIncompleteList\(styles\.scheduledRailProjectList\)/);
  assert.match(boardSource, /<li key=\{scheduled\.projectId\}/);
  assert.match(boardSource, /type="button"\s*className=\{styles\.scheduledProjectCard\}/);
  assert.match(boardSource, /aria-label=\{`Open \$\{customer\}.*in Project Track`\}/);
});

test("the horizontal scheduled tray is list-only instead of sitting above the calendar", () => {
  assert.match(
    boardSource,
    /\{view === "list" \? \(\s*<section\s*className=\{`\$\{styles\.traySection\} \$\{styles\.scheduledProjectsSection\}`\}/,
  );
  assert.match(boardSource, /renderScheduledIncompleteList\(styles\.scheduledProjectsList\)/);
});

test("override updates immediately refresh the shared navigation count", () => {
  const overrideUpdater = sourceBetween(
    boardSource,
    /async function updateSourceOverride\(entry: OverrideableEntry, action: SourceOverrideAction\) \{/,
    /\n  const renderSourceOverrideActions =/,
  );
  assert.match(overrideUpdater, /if \(!response\.ok\) throw new Error/);
  assert.match(overrideUpdater, /await refreshAll\(message\);/);
  assert.match(
    overrideUpdater,
    /window\.dispatchEvent\(new CustomEvent\("erp:project-schedule-updated", \{\s*detail: \{ source: "weekly-schedule" \},\s*\}\)\);/,
  );
});

test("scheduled project cards stack in the calendar rail while the list view stays horizontal and responsive", () => {
  assert.match(
    boardStyleSource,
    /\.scheduledRailEntries\s*\{[\s\S]*?flex:\s*1;[\s\S]*?overflow-y:\s*auto;/,
  );
  assert.match(
    boardStyleSource,
    /\.scheduledRailProjectList\s*\{[\s\S]*?flex-direction:\s*column;/,
  );
  assert.match(
    boardStyleSource,
    /\.scheduledRailProjectList \.scheduledProjectItem\s*\{[\s\S]*?width:\s*100%;[\s\S]*?flex:\s*0 0 auto;/,
  );
  assert.match(
    boardStyleSource,
    /\.traySection > \.scheduledProjectsHeader\s*\{[\s\S]*?position:\s*static;[\s\S]*?width:\s*auto;[\s\S]*?height:\s*auto;[\s\S]*?overflow:\s*visible;[\s\S]*?clip:\s*auto;[\s\S]*?clip-path:\s*none;[\s\S]*?white-space:\s*normal;/,
    "the generic visually-hidden tray header rule must be explicitly undone",
  );
  assert.match(
    boardStyleSource,
    /\.scheduledProjectsList\s*\{[\s\S]*?display:\s*flex;[\s\S]*?overflow-x:\s*auto;[\s\S]*?scroll-snap-type:\s*x proximity;/,
  );
  assert.match(
    boardStyleSource,
    /\.scheduledProjectItem\s*\{[\s\S]*?flex:\s*0 0 300px;[\s\S]*?scroll-snap-align:\s*start;/,
  );
  assert.match(
    boardStyleSource,
    /@media \(max-width:\s*680px\)[\s\S]*?\.scheduledProjectsList\s*\{[\s\S]*?scroll-snap-type:\s*x mandatory;[\s\S]*?\.scheduledProjectItem\s*\{[\s\S]*?flex-basis:\s*min\(82vw, 290px\);/,
  );
});

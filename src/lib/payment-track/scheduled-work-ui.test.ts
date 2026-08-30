import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const componentSource = await readFile(
  new URL("../../components/project-delivery-board.tsx", import.meta.url),
  "utf8",
);
const styleSource = await readFile(
  new URL("../../components/project-delivery-board.module.css", import.meta.url),
  "utf8",
);

test("Weekly Schedule uses one calendar-aligned WIP unscheduled rail", () => {
  assert.match(componentSource, /wipUnscheduledPaymentTrackProjects\(projects\)/);
  assert.match(componentSource, /<strong id="schedule-rail-title">WIP · Unscheduled<\/strong>/);
  assert.match(componentSource, /id="wip-unscheduled-projects-rail-panel"/);
  assert.match(componentSource, /projectsToRender\.map\(renderWipUnscheduledProject\)/);
  assert.match(
    componentSource,
    /<div className=\{styles\.calendarScheduleFrame\}>[\s\S]*?\{renderWipUnscheduledRail\(\)\}[\s\S]*?<div className=\{styles\.calendarScroller\}>/,
  );
  assert.match(
    styleSource,
    /\.calendarScheduleFrame > \.calendarScroller\s*\{[\s\S]*?align-items:\s*stretch;/,
  );
  assert.doesNotMatch(componentSource, /ScheduleRailView|railView|scheduleRailTabs/);
  assert.doesNotMatch(componentSource, /Scheduled · Not completed/);
});

test("the calendar WIP rail shows exactly three projects per page", () => {
  assert.match(componentSource, /const WIP_PROJECTS_PER_PAGE = 3;/);
  assert.match(
    componentSource,
    /const wipUnscheduledPageStart = activeWipUnscheduledPage \* WIP_PROJECTS_PER_PAGE;[\s\S]*?wipUnscheduledProjects\.slice\([\s\S]*?wipUnscheduledPageStart,[\s\S]*?wipUnscheduledPageStart \+ WIP_PROJECTS_PER_PAGE/,
  );
  assert.match(
    componentSource,
    /setWipUnscheduledPage\(\(current\) => Math\.min\(current, wipUnscheduledPageCount - 1\)\)/,
  );
  assert.match(componentSource, /aria-label="Previous WIP projects page"/);
  assert.match(componentSource, /aria-label="Next WIP projects page"/);
  assert.match(componentSource, /aria-controls="wip-unscheduled-projects-rail-panel"/);
  assert.match(componentSource, /Page \{activeWipUnscheduledPage \+ 1\} of \{wipUnscheduledPageCount\}/);
  assert.match(styleSource, /--calendar-frame-min-height:\s*744px/);
  assert.equal((styleSource.match(/min-height:\s*var\(--calendar-frame-min-height\)/g) ?? []).length, 2);
  assert.match(
    componentSource,
    /renderWipUnscheduledList\(styles\.scheduledRailProjectList, pagedWipUnscheduledProjects\)/,
  );
  assert.match(
    componentSource,
    /renderWipUnscheduledList\(styles\.scheduledProjectsList\)/,
  );
});

test("WIP cards open the exact Project Track project", () => {
  assert.match(componentSource, /onOpenProjectTrackProject\?\.\(unscheduled\.projectId\)/);
  assert.match(componentSource, /aria-label=\{`Open \$\{customer\}.*in Project Track`\}/);
  assert.match(componentSource, /Open Project Track <ChevronRight/);
});

test("the WIP queue does not report a false zero while Project Track is unavailable", () => {
  assert.match(componentSource, /const wipUnscheduledReady = paymentSourceReady;/);
  assert.match(componentSource, /wipUnscheduledReady \? wipUnscheduledProjects\.length : "—"/);
  assert.match(componentSource, /Working in Progress projects could not be loaded/);
});

test("WIP cards stack vertically in the calendar rail and remain responsive in list view", () => {
  assert.match(
    styleSource,
    /\.scheduledRailProjectList\s*\{[\s\S]*?flex-direction:\s*column;/,
  );
  assert.match(
    styleSource,
    /\.scheduledRailProjectList \.scheduledProjectItem\s*\{[\s\S]*?width:\s*100%;[\s\S]*?flex:\s*0 0 auto;/,
  );
  assert.match(
    styleSource,
    /\.scheduledProjectsList\s*\{[\s\S]*?display:\s*flex;[\s\S]*?overflow-x:\s*auto;/,
  );
  assert.match(styleSource, /\.scheduledProjectItem\s*\{[\s\S]*?flex:\s*0 0 300px;/);
  assert.match(
    styleSource,
    /@media \(max-width:\s*680px\)[\s\S]*?\.scheduledProjectItem\s*\{[^}]*flex-basis:\s*min\(82vw, 290px\);/,
  );
});

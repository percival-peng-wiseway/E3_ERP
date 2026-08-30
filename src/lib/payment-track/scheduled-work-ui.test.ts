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
  assert.match(componentSource, /wipUnscheduledProjects\.map\(renderWipUnscheduledProject\)/);
  assert.doesNotMatch(componentSource, /ScheduleRailView|railView|scheduleRailTabs/);
  assert.doesNotMatch(componentSource, /Scheduled · Not completed/);
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

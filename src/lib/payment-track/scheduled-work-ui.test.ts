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

test("Weekly Schedule defaults the calendar-aligned rail to global scheduled-incomplete Project Track work", () => {
  assert.match(
    componentSource,
    /scheduledIncompletePaymentTrackProjects\(projects, sourceOverrideState\)/,
    "the rail and navigation badge should share the override-aware selector",
  );
  assert.match(componentSource, /useState<ScheduleRailView>\("scheduled"\)/);
  assert.match(componentSource, /"Scheduled · Not completed"/);
  assert.match(componentSource, /id="scheduled-projects-rail-panel"/);
  assert.match(componentSource, /<small>All dates<\/small>/);
  assert.match(componentSource, /scheduledIncompleteProjects\.map\(renderScheduledIncompleteProject\)/);
  assert.match(componentSource, /onOpenProjectTrackProject\?\.\(scheduled\.projectId\)/);
  assert.match(componentSource, /Open Project Track/);
});

test("the rail does not report a false zero while either source is unavailable", () => {
  assert.match(componentSource, /scheduledIncompleteReady = paymentSourceReady && sourceOverridesReady/);
  assert.match(componentSource, /scheduledIncompleteReady \? scheduledIncompleteProjects\.length : "—"/);
  assert.match(componentSource, /Scheduled Project Track projects could not be loaded/);
});

test("scheduled cards stack vertically in the calendar rail and remain responsive in list view", () => {
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

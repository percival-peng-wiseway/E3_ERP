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

test("Weekly Schedule shows one global scheduled-incomplete Project Track tray", () => {
  assert.match(
    componentSource,
    /scheduledIncompletePaymentTrackProjects\(projects, sourceOverrideState\)/,
    "the tray and navigation badge should share the override-aware selector",
  );
  assert.match(componentSource, /Scheduled projects · Not completed/);
  assert.match(componentSource, /<small>All dates<\/small>/);
  assert.match(componentSource, /scheduledIncompleteProjects\.map\(renderScheduledIncompleteProject\)/);
  assert.match(componentSource, /onOpenProjectTrackProject\?\.\(scheduled\.projectId\)/);
  assert.match(componentSource, /Open Project Track/);
});

test("the tray does not report a false zero while either source is unavailable", () => {
  assert.match(componentSource, /scheduledIncompleteReady = paymentSourceReady && sourceOverridesReady/);
  assert.match(componentSource, /scheduledIncompleteReady \? scheduledIncompleteProjects\.length : "—"/);
  assert.match(componentSource, /Scheduled Project Track projects could not be loaded/);
});

test("scheduled project cards scroll horizontally and fit mobile screens", () => {
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

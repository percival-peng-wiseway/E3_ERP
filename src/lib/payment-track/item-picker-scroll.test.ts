import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const componentSource = await readFile(
  new URL("../../components/payment-track-workspace.tsx", import.meta.url),
  "utf8",
);
const styleSource = await readFile(
  new URL("../../components/payment-track-workspace.module.css", import.meta.url),
  "utf8",
);

test("the warehouse item picker keeps the project detail scroll container active", () => {
  assert.doesNotMatch(componentSource, /inert=\{showDeliveryPicker/);
  assert.match(componentSource, /showDeliveryPicker \? styles\.detailReferencePane : ""/);
  assert.match(componentSource, /deliveryPickerTriggerRef\.current = trigger;\s+trigger\.blur\(\);/);

  assert.match(
    styleSource,
    /\.detailReferencePane \.detailBody\s*\{[^}]*overscroll-behavior:\s*contain;[^}]*scrollbar-gutter:\s*stable;/,
  );
  assert.doesNotMatch(
    styleSource,
    /\.detailPickerShellOpen\s*>\s*\.detailModal\s*\{[^}]*pointer-events:\s*none;/,
  );
});

test("the reference pane stays read-only while the picker is open", () => {
  for (const element of ["button", "input", "select", "textarea", "a", "label"]) {
    assert.match(styleSource, new RegExp(`\\.detailReferencePane ${element}`));
  }
  assert.match(
    styleSource,
    /\.detailReferencePane label\s*\{\s*pointer-events:\s*none;/,
  );
  assert.match(
    styleSource,
    /@media \(max-width:\s*760px\)[\s\S]*?\.detailPickerShellOpen\s*>\s*\.detailModal\s*\{\s*visibility:\s*hidden;/,
  );
});

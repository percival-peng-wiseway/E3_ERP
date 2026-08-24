import assert from "node:assert/strict";
import test from "node:test";

const validationModule = "./validation.ts";
const {
  initialSiteVisitChecklist,
  MAX_SITE_VISIT_CHECKS,
  normalizeStoredSiteVisitChecklist,
  parseSiteVisitChecklist,
  parseSiteVisitPatch,
  SITE_VISIT_BUILT_IN_CHECKS,
} = await import(validationModule) as typeof import("./validation");

const legacyChecklist = [
  {
    id: "roof_tiles_attention",
    label: "Roof tiles need attention",
    answer: "yes" as const,
    notes: "Replace two cracked tiles",
  },
  {
    id: "switchboard_replacement",
    label: "Switchboard needs replacement",
    answer: "no" as const,
    notes: "Existing board is suitable",
  },
];

test("new site visits receive every current built-in check in the requested order", () => {
  assert.deepEqual(
    SITE_VISIT_BUILT_IN_CHECKS.map(({ id, label }) => ({ id, label })),
    [
      { id: "roof_tiles_attention", label: "Roof tiles need attention" },
      { id: "switchboard_replacement", label: "Switchboard needs replacement" },
      { id: "ac_cable_run_under_20m", label: "AC Cable Run <20m" },
      { id: "roof_material", label: "Roof Material" },
      { id: "bat_location", label: "BAT Location" },
      { id: "fire_cement_sheet", label: "Fire Cement Sheet" },
      { id: "sub_switchboard", label: "Sub-Switchboard" },
      { id: "switch_upgrade", label: "Switch Upgrade" },
      { id: "backup_circuit", label: "Backup Circuit" },
      { id: "concrete_slab", label: "Concrete Slab" },
    ],
  );
  assert.deepEqual(
    initialSiteVisitChecklist(),
    SITE_VISIT_BUILT_IN_CHECKS.map((item) => ({ ...item, answer: "not_checked", notes: "" })),
  );
});

test("stored legacy checklists are hydrated without losing answers or notes", () => {
  const parsed = normalizeStoredSiteVisitChecklist(legacyChecklist);
  assert.ok(parsed);
  assert.equal(parsed.length, 10);
  assert.deepEqual(parsed.slice(0, 2), legacyChecklist);
  assert.deepEqual(
    parsed.slice(2),
    SITE_VISIT_BUILT_IN_CHECKS.slice(2).map((item) => ({ ...item, answer: "not_checked", notes: "" })),
  );
  assert.equal(parseSiteVisitChecklist(legacyChecklist), null);
  assert.equal(parseSiteVisitPatch({ checklist: legacyChecklist }), null);
});

test("stored built-in labels are canonical and extension checks remain after built-ins", () => {
  const parsed = normalizeStoredSiteVisitChecklist([
    { ...legacyChecklist[0], label: "Changed in an old browser" },
    legacyChecklist[1],
    { id: "custom_meter_clearance", label: "Meter clearance", answer: "unknown", notes: "Confirm onsite" },
  ]);
  assert.ok(parsed);
  assert.equal(parsed[0].label, "Roof tiles need attention");
  assert.deepEqual(parsed.at(-1), {
    id: "custom_meter_clearance",
    label: "Meter clearance",
    answer: "unknown",
    notes: "Confirm onsite",
  });
});

test("malformed legacy checklists remain invalid instead of hiding data corruption", () => {
  assert.equal(normalizeStoredSiteVisitChecklist([legacyChecklist[0]]), null);
  assert.equal(normalizeStoredSiteVisitChecklist([legacyChecklist[0], legacyChecklist[0]]), null);
  assert.equal(normalizeStoredSiteVisitChecklist([
    legacyChecklist[0],
    { ...legacyChecklist[1], answer: "maybe" },
  ]), null);
});

test("current checklists parse strictly and retain the legacy custom-item capacity", () => {
  const current = initialSiteVisitChecklist();
  current[2] = { ...current[2], answer: "yes", notes: "Measured 18 m" };
  assert.deepEqual(parseSiteVisitChecklist(current), current);
  assert.equal(parseSiteVisitPatch({ checklist: current })?.checklist?.[2].notes, "Measured 18 m");

  const customChecks = Array.from({ length: 38 }, (_, index) => ({
    id: `custom_check_${index}`,
    label: `Custom check ${index}`,
    answer: "not_checked" as const,
    notes: "",
  }));
  const hydrated = normalizeStoredSiteVisitChecklist([...legacyChecklist, ...customChecks]);
  assert.equal(hydrated?.length, MAX_SITE_VISIT_CHECKS);
  assert.equal(
    normalizeStoredSiteVisitChecklist([
      ...legacyChecklist,
      ...customChecks,
      { id: "one_too_many", label: "One too many", answer: "not_checked", notes: "" },
    ]),
    null,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

const validationModule = "./validation.ts";
const {
  initialSiteVisitChecklist,
  MAX_SITE_VISIT_CHECKS,
  normalizeStoredSiteVisitChecklist,
  parseSiteVisitAction,
  parseSiteVisitChecklist,
  parseSiteVisitCreate,
  SITE_VISIT_BUILT_IN_CHECKS,
} = await import(validationModule) as typeof import("./validation");

const expectedUpdatedAt = "2026-08-24T01:02:03.004Z";
const validRequest = {
  projectName: "Smith residence",
  address: "1 Test Street, Melbourne VIC 3000",
  contact: "+61 400 000 000",
  reason: "Confirm roof and switchboard requirements",
  requestedDate: "2026-08-28",
  requestedTime: "10:30",
};
const validCreate = {
  createdBy: "Ruihan" as const,
  ...validRequest,
};

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

test("site visit requests strictly require an allowed creator, customer, phone, reason and requested date/time", () => {
  assert.deepEqual(parseSiteVisitCreate(validCreate), validCreate);
  for (const createdBy of ["Ruihan", "Kevin", "Hogan", "Sam"] as const) {
    assert.equal(parseSiteVisitCreate({ ...validCreate, createdBy })?.createdBy, createdBy);
  }

  for (const field of Object.keys(validCreate)) {
    const missing = { ...validCreate } as Record<string, unknown>;
    delete missing[field];
    assert.equal(parseSiteVisitCreate(missing), null, `${field} must be required`);
  }

  assert.equal(parseSiteVisitCreate({ ...validCreate, contact: "" }), null);
  assert.equal(parseSiteVisitCreate({ ...validCreate, reason: "" }), null);
  assert.equal(parseSiteVisitCreate({ ...validCreate, requestedDate: "2026-02-30" }), null);
  assert.equal(parseSiteVisitCreate({ ...validCreate, requestedTime: "24:00" }), null);
  assert.equal(parseSiteVisitCreate({ ...validCreate, createdBy: "Jerry" }), null);
  assert.equal(parseSiteVisitCreate({ ...validCreate, createdBy: " ruihan " }), null);
  assert.equal(parseSiteVisitCreate({ ...validCreate, scheduledDate: "2026-08-29" }), null);
  assert.equal(parseSiteVisitCreate({ ...validCreate, unexpected: true }), null);
});

test("workflow actions require an exact action payload and current updated timestamp", () => {
  for (const action of ["approve", "start", "complete", "reopen", "cancel", "restore"] as const) {
    assert.deepEqual(
      parseSiteVisitAction({ action, expectedUpdatedAt }),
      { action, expectedUpdatedAt },
    );
    assert.equal(parseSiteVisitAction({ action }), null, `${action} needs expectedUpdatedAt`);
    assert.equal(
      parseSiteVisitAction({ action, expectedUpdatedAt, status: "completed" }),
      null,
      `${action} must reject extra fields`,
    );
  }

  assert.equal(parseSiteVisitAction({ action: "approve", expectedUpdatedAt: "2026-08-24" }), null);
  assert.equal(parseSiteVisitAction({ action: "unknown", expectedUpdatedAt }), null);
  assert.equal(parseSiteVisitAction({ status: "completed", expectedUpdatedAt }), null);
});

test("request, schedule and visit-save actions parse only their exact fields", () => {
  assert.deepEqual(parseSiteVisitAction({
    action: "update_request",
    expectedUpdatedAt,
    ...validRequest,
  }), {
    action: "update_request",
    expectedUpdatedAt,
    ...validRequest,
  });
  assert.equal(parseSiteVisitAction({
    action: "update_request",
    expectedUpdatedAt,
    ...validRequest,
    assignee: "Field Team",
  }), null);
  assert.equal(parseSiteVisitAction({
    action: "update_request",
    expectedUpdatedAt,
    ...validRequest,
    createdBy: "Sam",
  }), null);

  assert.deepEqual(parseSiteVisitAction({
    action: "schedule",
    expectedUpdatedAt,
    scheduledDate: "2026-09-01",
    scheduledTime: "13:45",
    assignee: "Field Team",
  }), {
    action: "schedule",
    expectedUpdatedAt,
    scheduledDate: "2026-09-01",
    scheduledTime: "13:45",
    assignee: "Field Team",
  });
  assert.equal(parseSiteVisitAction({
    action: "schedule",
    expectedUpdatedAt,
    scheduledDate: "2026-09-01",
    scheduledTime: "13:45",
    assignee: "",
  }), null);
  assert.equal(parseSiteVisitAction({
    action: "schedule",
    expectedUpdatedAt,
    scheduledDate: "2026-09-01",
    scheduledTime: "13:45",
    assignee: "Field Team",
    requestedDate: "2026-08-28",
  }), null);

  const checklist = initialSiteVisitChecklist();
  checklist[0] = { ...checklist[0], answer: "yes", notes: "Replace two cracked tiles" };
  assert.deepEqual(parseSiteVisitAction({
    action: "save_visit",
    expectedUpdatedAt,
    projectName: validCreate.projectName,
    address: validCreate.address,
    contact: validCreate.contact,
    checklist,
    notes: "Gate code is 1234",
  }), {
    action: "save_visit",
    expectedUpdatedAt,
    projectName: validCreate.projectName,
    address: validCreate.address,
    contact: validCreate.contact,
    checklist,
    notes: "Gate code is 1234",
  });
  const legacySave = parseSiteVisitAction({
    action: "save_visit",
    expectedUpdatedAt,
    projectName: validCreate.projectName,
    address: validCreate.address,
    contact: "",
    checklist,
    notes: "Legacy record without a stored phone",
  });
  assert.equal(legacySave?.action === "save_visit" ? legacySave.contact : null, "");
  assert.equal(parseSiteVisitAction({
    action: "save_visit",
    expectedUpdatedAt,
    projectName: validCreate.projectName,
    address: validCreate.address,
    contact: validCreate.contact,
    checklist,
    notes: "",
    reason: validCreate.reason,
  }), null);
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
  assert.equal(parseSiteVisitAction({
    action: "save_visit",
    expectedUpdatedAt,
    projectName: validCreate.projectName,
    address: validCreate.address,
    contact: validCreate.contact,
    checklist: legacyChecklist,
    notes: "",
  }), null);
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
  const saved = parseSiteVisitAction({
    action: "save_visit",
    expectedUpdatedAt,
    projectName: validCreate.projectName,
    address: validCreate.address,
    contact: validCreate.contact,
    checklist: current,
    notes: "",
  });
  assert.equal(saved?.action === "save_visit" ? saved.checklist[2].notes : null, "Measured 18 m");

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

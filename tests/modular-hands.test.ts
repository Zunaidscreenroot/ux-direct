import assert from "node:assert/strict";
import test from "node:test";
import { getHandDefinition, UX_HANDS } from "../src/core/hand-contracts";
import {
  getDefaultHands,
  getProjectProfile,
  shouldRunInitialFoundation,
  UX_PROJECT_PROFILES,
} from "../src/core/project-profiles";

test("Cockpit is the default primary hand for every project profile", () => {
  for (const profile of UX_PROJECT_PROFILES) {
    assert.equal(profile.primaryHand, "cockpit");
    assert.deepEqual(getDefaultHands(profile.id), ["cockpit"]);
  }
});

test("DMI profiles stay brownfield and do not force an initial foundation workflow", () => {
  for (const id of ["dmi-hfc", "dmi-finance", "dmi-wealth"] as const) {
    const profile = getProjectProfile(id);
    assert.equal(profile.lifecycle, "brownfield");
    assert.equal(profile.initialFoundation.required, false);
    assert.equal(shouldRunInitialFoundation({ projectId: id }), false);
    assert.deepEqual(profile.initialFoundation.hands, []);
  }
});

test("Ujjivan starts with a greenfield foundation only if no approved kit exists", () => {
  const profile = getProjectProfile("ujjivan-sfb");
  assert.equal(profile.lifecycle, "greenfield");
  assert.equal(profile.initialFoundation.required, true);
  assert.equal(shouldRunInitialFoundation({ projectId: "ujjivan-sfb" }), true);
  assert.equal(
    shouldRunInitialFoundation({ projectId: "ujjivan-sfb", approvedKitVersion: "1.0.0" }),
    false,
  );
  assert.equal(
    shouldRunInitialFoundation({ projectId: "ujjivan-sfb", foundationMarkedComplete: true }),
    false,
  );
  assert.ok(profile.initialFoundation.hands.includes("wireframe-foundry"));
  assert.ok(profile.initialFoundation.hands.includes("journey-architect"));
  assert.ok(profile.initialFoundation.hands.includes("benchmark-lab"));
});

test("specialist hands exist in the shared catalogue but do not replace Cockpit", () => {
  const specialistIds = UX_HANDS.filter((hand) => hand.role === "specialist").map((hand) => hand.id);
  assert.ok(specialistIds.includes("wireframe-foundry"));
  assert.ok(specialistIds.includes("ux-auditor"));
  assert.ok(specialistIds.includes("benchmark-lab"));
  assert.ok(specialistIds.includes("journey-architect"));
  assert.equal(getHandDefinition("cockpit").role, "primary");
  assert.equal(getHandDefinition("cockpit").invocation, "default");
});

test("project memory namespaces are distinct between projects and clients", () => {
  const hfc = getProjectProfile("dmi-hfc");
  const finance = getProjectProfile("dmi-finance");
  const wealth = getProjectProfile("dmi-wealth");
  const ujjivan = getProjectProfile("ujjivan-sfb");

  assert.notEqual(hfc.knowledge.projectNamespace, finance.knowledge.projectNamespace);
  assert.notEqual(finance.knowledge.projectNamespace, wealth.knowledge.projectNamespace);
  assert.notEqual(hfc.knowledge.clientNamespace, ujjivan.knowledge.clientNamespace);
  assert.equal(hfc.knowledge.allowCrossProjectMemory, false);
  assert.equal(ujjivan.knowledge.allowCrossProjectMemory, false);
});

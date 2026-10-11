import test from "node:test";
import assert from "node:assert/strict";
import {
  REQUIRED_FIGMA_ACTION_CHECKS,
  buildHealthSmokeChecks,
  inspectHealthReport,
  type PluginHealthCheck,
  type PluginHealthReport,
} from "../src/quality/health-report";

function makeReport(extraChecks: PluginHealthCheck[] = []): PluginHealthReport {
  const actionChecks = REQUIRED_FIGMA_ACTION_CHECKS.map((name) => ({
    category: "Figma action",
    name,
    level: "functional" as const,
    status: "success" as const,
    reason: "Executed against a persistent fixture in the dedicated Test Lab.",
  }));
  const checks: PluginHealthCheck[] = [
    ...actionChecks,
    {
      category: "Library",
      name: "Team Library",
      level: "not-tested",
      status: "not-tested",
      reason: "Not tested intentionally: shared-library lookup and import are out of scope.",
    },
    ...Array.from({ length: 46 }, (_, index) => ({
      category: "Styles",
      name: "Availability probe " + (index + 1),
      level: "availability" as const,
      status: "success" as const,
      reason: "API availability checked without invoking it.",
    })),
    ...extraChecks,
  ];
  return {
    passed: checks.filter((item) => item.status === "success" && item.level !== "availability").length,
    available: checks.filter((item) => item.status === "success" && item.level === "availability").length,
    failed: checks.filter((item) => item.status === "error").length,
    notTested: checks.filter((item) => item.status === "not-tested").length,
    checkedAt: "2026-10-11T12:00:00.000Z",
    checks,
  };
}

test("health audit accepts a complete report with reconciled totals and intentional library exclusion", () => {
  const audit = inspectHealthReport(makeReport());
  assert.equal(audit.total, 53);
  assert.equal(audit.countsMatch, true);
  assert.equal(audit.actionCoverageComplete, true);
  assert.equal(audit.teamLibraryScopeCorrect, true);
  assert.deepEqual(audit.issues, []);
});

test("health audit reports the names of failed native API checks", () => {
  const report = makeReport([{
    category: "Text",
    name: "Write text characters",
    level: "functional",
    status: "error",
    reason: "The text content did not persist.",
  }]);
  const audit = inspectHealthReport(report);
  assert.equal(audit.countsMatch, true);
  assert.equal(audit.failedChecks.length, 1);
  assert.equal(audit.failedChecks[0].name, "Write text characters");
  assert.ok(audit.issues.some((issue) => issue.includes("Write text characters")));
});

test("health audit catches a summary count mismatch", () => {
  const report = makeReport();
  report.passed += 1;
  const audit = inspectHealthReport(report);
  assert.equal(audit.countsMatch, false);
  assert.ok(audit.issues.some((issue) => issue.includes("Summary mismatch")));
});

test("health audit catches a short inventory and missing required action checks", () => {
  const report = makeReport().checks
    .filter((item) => !REQUIRED_FIGMA_ACTION_CHECKS.includes(item.name as typeof REQUIRED_FIGMA_ACTION_CHECKS[number]))
    .slice(0, 20);
  const summary = {
    passed: report.filter((item) => item.status === "success" && item.level !== "availability").length,
    available: report.filter((item) => item.status === "success" && item.level === "availability").length,
    failed: report.filter((item) => item.status === "error").length,
    notTested: report.filter((item) => item.status === "not-tested").length,
    checkedAt: "2026-10-11T12:00:00.000Z",
    checks: report,
  };
  const audit = inspectHealthReport(summary);
  assert.ok(audit.total < 52);
  assert.ok(audit.issues.some((issue) => issue.includes("Inventory is incomplete")));
  assert.ok(audit.missingActions.length > 0);
});

test("health audit fails closed when Team Library is tested or its intent is unclear", () => {
  const report = makeReport();
  const library = report.checks.find((item) => item.name === "Team Library");
  assert.ok(library);
  library.level = "functional";
  library.status = "error";
  library.reason = "Attempted to inspect shared library.";
  report.passed = report.checks.filter((item) => item.status === "success" && item.level !== "availability").length;
  report.available = report.checks.filter((item) => item.status === "success" && item.level === "availability").length;
  report.failed = report.checks.filter((item) => item.status === "error").length;
  report.notTested = report.checks.filter((item) => item.status === "not-tested").length;
  const audit = inspectHealthReport(report);
  assert.equal(audit.teamLibraryScopeCorrect, false);
});

test("smoke test blocks live plugin-specific tests when no report/session exists", () => {
  const results = buildHealthSmokeChecks({
    backendHealthy: true,
    bridgeReachable: true,
    pluginOnline: false,
    report: null,
  });
  assert.equal(results.find((item) => item.name === "Backend health endpoint")?.status, "pass");
  assert.equal(results.find((item) => item.name === "Figma plugin session")?.status, "blocked");
  assert.equal(results.find((item) => item.name === "Persisted health report")?.status, "blocked");
});

test("smoke test fails when an online plugin has no persisted report or when actions fail", () => {
  const missingReport = buildHealthSmokeChecks({
    backendHealthy: true,
    bridgeReachable: true,
    pluginOnline: true,
    report: null,
  });
  assert.equal(missingReport.find((item) => item.name === "Persisted health report")?.status, "fail");

  const failedReport = makeReport([{
    category: "Shapes",
    name: "Resize shape",
    level: "functional",
    status: "error",
    reason: "Unexpected dimensions after resize.",
  }]);
  const results = buildHealthSmokeChecks({
    backendHealthy: true,
    bridgeReachable: true,
    pluginOnline: true,
    report: failedReport,
  });
  assert.equal(results.find((item) => item.name === "Native Figma action results")?.status, "fail");
});

export type HealthCheckLevel = "availability" | "functional" | "not-tested";
export type HealthCheckStatus = "success" | "error" | "not-tested";

export type PluginHealthCheck = {
  category: string;
  name: string;
  level: HealthCheckLevel;
  status: HealthCheckStatus;
  reason: string;
};

export type PluginHealthReport = {
  passed: number;
  available?: number;
  failed: number;
  notTested: number;
  checkedAt: string;
  checks: PluginHealthCheck[];
};

export type HealthReportAudit = {
  total: number;
  computed: { passed: number; available: number; failed: number; notTested: number };
  failedChecks: PluginHealthCheck[];
  missingActions: string[];
  teamLibraryChecks: PluginHealthCheck[];
  issues: string[];
  countsMatch: boolean;
  actionCoverageComplete: boolean;
  teamLibraryScopeCorrect: boolean;
};

export type SmokeCheckResult = {
  name: string;
  status: "pass" | "fail" | "blocked";
  message: string;
};

export type HealthSmokeInputs = {
  backendHealthy: boolean;
  bridgeReachable: boolean;
  pluginOnline: boolean;
  report: PluginHealthReport | null;
};

// Keep these names stable: the smoke test uses them to ensure new native
// Figma actions remain in the report as real functional tests.
export const REQUIRED_FIGMA_ACTION_CHECKS = [
  "Clone node and verify properties",
  "Apply frame auto layout",
  "Rotate node and set constraints",
  "Set and verify text range font size",
  "Export shape to SVG",
  "Reorder nodes with insertChild",
] as const;

export const MIN_HEALTH_INVENTORY_SIZE = 58;

export function inspectHealthReport(report: PluginHealthReport): HealthReportAudit {
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const computed = {
    passed: checks.filter((item) => item.status === "success" && item.level !== "availability").length,
    available: checks.filter((item) => item.status === "success" && item.level === "availability").length,
    failed: checks.filter((item) => item.status === "error").length,
    notTested: checks.filter((item) => item.status === "not-tested").length,
  };
  const failedChecks = checks.filter((item) => item.status === "error");
  const missingActions = REQUIRED_FIGMA_ACTION_CHECKS.filter((name) =>
    !checks.some((item) => item.name === name && item.level === "functional")
  );
  const teamLibraryChecks = checks.filter((item) => /team library/i.test(item.name));
  const teamLibraryScopeCorrect = teamLibraryChecks.length === 1
    && teamLibraryChecks[0].level === "not-tested"
    && teamLibraryChecks[0].status === "not-tested"
    && /not tested intentionally/i.test(teamLibraryChecks[0].reason);

  const countsMatch = report.passed === computed.passed
    && (report.available ?? 0) === computed.available
    && report.failed === computed.failed
    && report.notTested === computed.notTested;

  const issues: string[] = [];
  if (checks.length < MIN_HEALTH_INVENTORY_SIZE) {
    issues.push(`Inventory is incomplete: ${checks.length} checks found; expected at least ${MIN_HEALTH_INVENTORY_SIZE}.`);
  }
  if (!countsMatch) {
    issues.push(
      `Summary mismatch: report says ${report.passed}/${report.failed}/${report.available ?? 0}/${report.notTested} (pass/fail/available/not tested), ` +
      `but rows calculate to ${computed.passed}/${computed.failed}/${computed.available}/${computed.notTested}.`
    );
  }
  if (missingActions.length) issues.push(`Missing functional Figma action checks: ${missingActions.join(", ")}.`);
  if (!teamLibraryScopeCorrect) {
    issues.push("Team Library must appear once as “not tested intentionally”; shared-library APIs must remain out of scope.");
  }
  if (failedChecks.length) {
    issues.push(`${failedChecks.length} check(s) failed: ${failedChecks.map((item) => item.name).join(", ")}.`);
  }

  return {
    total: checks.length,
    computed,
    failedChecks,
    missingActions: [...missingActions],
    teamLibraryChecks,
    issues,
    countsMatch,
    actionCoverageComplete: missingActions.length === 0,
    teamLibraryScopeCorrect,
  };
}

export function buildHealthSmokeChecks(input: HealthSmokeInputs): SmokeCheckResult[] {
  const results: SmokeCheckResult[] = [
    {
      name: "Backend health endpoint",
      status: input.backendHealthy ? "pass" : "fail",
      message: input.backendHealthy ? "Netlify health endpoint returned a healthy response." : "Health endpoint did not return status=ok.",
    },
    {
      name: "Plugin bridge",
      status: input.bridgeReachable ? "pass" : "fail",
      message: input.bridgeReachable ? "Bridge state endpoint was reachable." : "Could not read persistent plugin bridge state.",
    },
    {
      name: "Figma plugin session",
      status: input.pluginOnline ? "pass" : "blocked",
      message: input.pluginOnline ? "An active Figma plugin heartbeat is present." : "Open the UX Direct plugin in the approved Figma file to run live plugin checks.",
    },
  ];

  if (!input.report) {
    results.push({
      name: "Persisted health report",
      status: input.pluginOnline ? "fail" : "blocked",
      message: input.pluginOnline
        ? "Plugin is online, but no persisted native API report was returned."
        : "No native API report is available yet. Run the plugin health check first.",
    });
    return results;
  }

  const audit = inspectHealthReport(input.report);
  results.push(
    {
      name: "Persisted health report",
      status: "pass",
      message: `Report timestamp: ${input.report.checkedAt || "unknown"}.`,
    },
    {
      name: "Inventory size",
      status: audit.total >= MIN_HEALTH_INVENTORY_SIZE ? "pass" : "fail",
      message: `${audit.total} checks found; minimum expected is ${MIN_HEALTH_INVENTORY_SIZE}.`,
    },
    {
      name: "Report count integrity",
      status: audit.countsMatch ? "pass" : "fail",
      message: audit.countsMatch ? "Summary totals match the individual check rows." : "One or more summary totals do not match the individual check rows.",
    },
    {
      name: "Figma action coverage",
      status: audit.actionCoverageComplete ? "pass" : "fail",
      message: audit.actionCoverageComplete ? "All required Figma action smoke checks are present." : `Missing: ${audit.missingActions.join(", ")}.`,
    },
    {
      name: "Team Library scope",
      status: audit.teamLibraryScopeCorrect ? "pass" : "fail",
      message: audit.teamLibraryScopeCorrect ? "Team Library is explicitly marked not tested intentionally." : "Team Library scope marker is missing, duplicated, or incorrectly tested.",
    },
    {
      name: "Native Figma action results",
      status: audit.failedChecks.length === 0 ? "pass" : "fail",
      message: audit.failedChecks.length === 0
        ? `No failed checks; ${audit.computed.passed} functional pass, ${audit.computed.available} available-only, ${audit.computed.notTested} not tested.`
        : `${audit.failedChecks.length} failed: ${audit.failedChecks.map((item) => item.name).join(", ")}.`,
    },
  );
  return results;
}

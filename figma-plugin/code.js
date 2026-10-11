// STRICT SCOPE: reject every file except the exact allowlisted key before reading document pages.
// STRICT SCOPE: this plugin is disabled until the exact approved Figma file key is configured.
var UXD_ALLOWED_FILE_NAME = "Zunaid_Workspace";
var UXD_ALLOWED_FILE_KEY = "QJhcsebwscpdMJDNh9UsYS";
function getUxDirectScopeDecision() {
  // Fail closed using file identity only. Do not read figma.root, currentPage,
  // selection, or other document/page nodes before the exact key is approved.
  var fileKey = "";
  try { fileKey = typeof figma.fileKey === "string" ? figma.fileKey : ""; } catch (_) {}
  if (!UXD_ALLOWED_FILE_KEY) {
    return { allowed: false, reason: "The approved Figma file key is not configured." };
  }
  if (!fileKey) {
    return { allowed: false, reason: "Figma did not expose the file key; access is denied by default." };
  }
  if (fileKey !== UXD_ALLOWED_FILE_KEY) {
    return { allowed: false, reason: "This is not the allowlisted Figma file." };
  }
  return { allowed: true, reason: "Approved file key verified." };
}
function startScopedPlugin() {
  // Create the UI only after the file allowlist succeeds, before any UI messages.
  figma.showUI(__html__, { width: 380, height: 720, themeColors: true });
function getSelectionSummary() {
  return figma.currentPage.selection.map(function (node) {
    return { id: node.id, name: node.name, type: node.type, visible: node.visible,
      childCount: "children" in node ? node.children.length : undefined };
  });
}
function sendSelection() {
  figma.ui.postMessage({ type: "selection", fileKey: figma.fileKey || null,
    pageName: figma.currentPage.name, selection: getSelectionSummary() });
}
figma.on("selectionchange", sendSelection);
function runNativeApiHealthCheck(commandId) {
  var checks = [];
  function add(category, name, level, ok, reason) {
    var status = level === "not-tested" ? "not-tested" : (ok ? "success" : "error");
    checks.push({ category: category, name: name, level: level, status: status,
      reason: reason || (ok ? "Verified" : "Check failed") });
  }
  function api(category, name, value) {
    add(category, name, "availability", value !== undefined && value !== null, value == null ?
      "API/property unavailable in this plugin runtime" : "API exists; operation not executed");
  }
  function safeRead(category, name, fn) {
    try { fn(); add(category, name, "functional", true, "Read-only operation succeeded"); }
    catch (e) { add(category, name, "functional", false, e && e.message ? e.message : String(e)); }
  }
  safeRead("Selection", "Read current selection", function () {
    if (!Array.isArray(figma.currentPage.selection)) throw new Error("Selection is not an array");
  });
  safeRead("Selection", "Read selection metadata", function () {
    if (!Array.isArray(getSelectionSummary())) throw new Error("Metadata extraction did not return an array");
  });
  safeRead("Node inspection", "Read current page name and ID", function () {
    if (!figma.currentPage.name || !figma.currentPage.id) throw new Error("Page name or ID missing");
  });
  safeRead("Node inspection", "Read current page children", function () {
    if (!Array.isArray(figma.currentPage.children)) throw new Error("Page children unavailable");
  });
  safeRead("Node inspection", "Read selected node parent/visibility", function () {
    figma.currentPage.selection.forEach(function (n) { void n.parent; void n.visible; void n.type; void n.name; });
  });
  safeRead("Viewport", "Read viewport bounds and zoom", function () {
    if (!figma.viewport.bounds || typeof figma.viewport.zoom !== "number") throw new Error("Viewport data unavailable");
  });
  safeRead("Plugin bridge", "Read UI bridge and postMessage", function () {
    if (!figma.ui || typeof figma.ui.postMessage !== "function") throw new Error("UI message bridge unavailable");
  });
  [
    ["Selection","figma.on / selectionchange",figma.on],["Selection","figma.off",figma.off],
    ["Node inspection","figma.getNodeByIdAsync",figma.getNodeByIdAsync],["Node inspection","figma.getNodeById (legacy)",figma.getNodeById],
    ["Page navigation","figma.createPage",figma.createPage],["Page navigation","figma.setCurrentPageAsync",figma.setCurrentPageAsync],
    ["Shapes","figma.createFrame",figma.createFrame],["Shapes","figma.createRectangle",figma.createRectangle],
    ["Shapes","figma.createEllipse",figma.createEllipse],["Shapes","figma.createLine",figma.createLine],
    ["Shapes","figma.createPolygon",figma.createPolygon],["Shapes","figma.createStar",figma.createStar],["Shapes","figma.createVector",figma.createVector],
    ["Text","figma.createText",figma.createText],["Text","figma.loadFontAsync",figma.loadFontAsync],
    ["Components","figma.createComponent",figma.createComponent],["Components","figma.createComponentFromNode",figma.createComponentFromNode],
    ["Components","figma.combineAsVariants",figma.combineAsVariants],["Components","figma.createInstance",figma.createInstance],
    ["Layout and styling","figma.group",figma.group],["Layout and styling","figma.flatten",figma.flatten],
    ["Layout and styling","figma.union",figma.union],["Layout and styling","figma.intersect",figma.intersect],
    ["Layout and styling","figma.subtract",figma.subtract],["Layout and styling","figma.exclude",figma.exclude],
    ["Variables","figma.variables",figma.variables],
    ["Storage","figma.clientStorage",figma.clientStorage],["Viewport","figma.viewport",figma.viewport],
    ["Export","Node exportAsync",figma.currentPage && figma.currentPage.exportAsync],
    ["Events","figma.on",figma.on],["Events","figma.once",figma.once],
    ["Plugin bridge","figma.ui.onmessage",figma.ui && figma.ui.onmessage],
    ["Plugin lifecycle","figma.closePlugin",figma.closePlugin],["Plugin utilities","figma.notify",figma.notify],
    ["Plugin utilities","figma.openExternal",figma.openExternal]
  ].forEach(function (item) { api(item[0], item[1], item[2]); });
  add("Library", "Team library access", "not-tested", false, "Skipped intentionally: the teamlibrary permission is not granted. UX Direct must not inspect or import organization library assets.");
  [
    ["Selection","Selection change event delivery","Requires a user to change selection after this test starts"],
    ["Page navigation","Switch page operation","Not executed to avoid changing the user's active page"],
    ["Shapes","Create/delete shape operation","Not executed to avoid modifying the design document"],
    ["Text","Write text / change font operation","Not executed to avoid modifying the design document"],
    ["Layout and styling","Modify layout or visual styles","Not executed to avoid modifying the design document"],
    ["Components","Create component/variant operation","Not executed to avoid modifying the design document"],
    ["Variables","Read/write variable values","Variable operations not executed in this non-destructive check"],
    ["Export","Export selected node","Export not executed; only API availability was checked"]
  ].forEach(function (item) { add(item[0], item[1], "not-tested", false, item[2]); });
  var passed = checks.filter(function (x) { return x.status === "success"; }).length;
  var failed = checks.filter(function (x) { return x.status === "error"; }).length;
  var notTested = checks.filter(function (x) { return x.status === "not-tested"; }).length;
  figma.ui.postMessage({ type: "native-health-result", checks: checks, passed: passed, failed: failed,
    notTested: notTested, commandId: commandId || null, checkedAt: new Date().toISOString() });
}
figma.ui.onmessage = function (message) {
  if (!message) return;
  if (message.type === "get-selection") sendSelection();
  if (message.type === "run-native-health-check") runNativeApiHealthCheck(message.commandId);
  if (message.type === "close") figma.closePlugin();
};
sendSelection();

}
var uxdScopeDecision = getUxDirectScopeDecision();
if (uxdScopeDecision.allowed) {
  startScopedPlugin();
} else {
  figma.closePlugin("UX Direct blocked: " + uxdScopeDecision.reason + " Only the approved Zunaid_Workspace file is allowed.");
}

// STRICT SCOPE: reject every file except the exact allowlisted key before reading document pages.
// STRICT SCOPE: plugin entry runs only after the exact approved Figma file key matches.
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
var selectionChangeListenerRegistered = false;
figma.on("selectionchange", sendSelection);
selectionChangeListenerRegistered = true;
async function runNativeApiHealthCheck(commandId) {
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
  async function safeReadAsync(category, name, fn) {
    try {
      var reason = await fn();
      add(category, name, "functional", true, typeof reason === "string" ? reason : "Read-only async operation succeeded");
    } catch (e) {
      add(category, name, "functional", false, e && e.message ? e.message : String(e));
    }
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
  await safeReadAsync("Node inspection", "Resolve current page by ID (async)", async function () {
    if (typeof figma.getNodeByIdAsync !== "function") throw new Error("getNodeByIdAsync is unavailable");
    var page = figma.currentPage;
    var resolved = await figma.getNodeByIdAsync(page.id);
    if (!resolved || resolved.id !== page.id) throw new Error("Could not resolve the active page by its ID");
    return "Read-only lookup succeeded for the active page; no page or document state changed";
  });
  await safeReadAsync("Variables", "Read local variable definitions", async function () {
    if (!figma.variables || typeof figma.variables.getLocalVariablesAsync !== "function" ||
        typeof figma.variables.getLocalVariableCollectionsAsync !== "function") {
      throw new Error("Read-only local variable APIs are unavailable");
    }
    var variables = await figma.variables.getLocalVariablesAsync();
    var collections = await figma.variables.getLocalVariableCollectionsAsync();
    if (!Array.isArray(variables) || !Array.isArray(collections)) {
      throw new Error("Variable API did not return arrays");
    }
    return "Read-only current-file query succeeded (" + variables.length + " variables, " +
      collections.length + " collections); nothing was created or changed";
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
    ["Components","figma.combineAsVariants",figma.combineAsVariants],
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
  // createInstance is a ComponentNode method, not a global figma method.
  // Inspect an existing component on the active page without creating an instance.
  var componentForInstanceProbe = null;
  try {
    componentForInstanceProbe = figma.currentPage.findOne(function (node) { return node.type === "COMPONENT"; });
  } catch (_) {}
  if (componentForInstanceProbe) {
    api("Components", "ComponentNode.createInstance", componentForInstanceProbe.createInstance);
  }
  add("Library", "Team library access", "not-tested", false, "Skipped intentionally: the teamlibrary permission is not granted. UX Direct must not inspect or import organization library assets.");
  var sampleSceneNode = null;
  try {
    sampleSceneNode = figma.currentPage.selection[0] || figma.currentPage.children[0] || null;
  } catch (_) {}
  function availability(category, name, ok, reason) {
    add(category, name, "availability", !!ok, reason || (ok ? "API/property availability verified; operation not executed" : "Required API/property is unavailable"));
  }
  availability("Selection", "Selection change listener registration", selectionChangeListenerRegistered,
    "The figma.on('selectionchange') listener was registered at startup; event delivery requires a user selection change and is not forced by this test.");
  availability("Page navigation", "Page create/switch APIs",
    typeof figma.createPage === "function" && typeof figma.setCurrentPageAsync === "function",
    "Page APIs are checked by reference only; no page was created and the active page was not switched.");
  availability("Shapes", "Shape creation APIs",
    [figma.createFrame, figma.createRectangle, figma.createEllipse, figma.createLine,
      figma.createPolygon, figma.createStar, figma.createVector].every(function (value) { return typeof value === "function"; }),
    "Shape-creation APIs are available; no shape was created. Node.remove is inspected on a current-page node when one is present.");
  if (sampleSceneNode) {
    availability("Shapes", "SceneNode.remove API", typeof sampleSceneNode.remove === "function",
      "The remove method was checked on an existing current-page node; no node was removed.");
  }
  availability("Text", "Text creation and font-loading APIs",
    typeof figma.createText === "function" && typeof figma.loadFontAsync === "function",
    "Text creation and font-loading APIs are available; no text, font, or text property was changed.");
  availability("Layout and styling", "Node manipulation APIs",
    [figma.group, figma.flatten, figma.union, figma.intersect, figma.subtract, figma.exclude]
      .every(function (value) { return typeof value === "function"; }),
    "Grouping, flattening, and boolean-operation APIs are available; no geometry, layout, fill, or stroke was changed.");
  availability("Components", "Component and variant creation APIs",
    typeof figma.createComponent === "function" && typeof figma.createComponentFromNode === "function" &&
      typeof figma.combineAsVariants === "function",
    "Component and variant APIs are available; no component or variant was created. ComponentNode.createInstance is separately checked when a component exists on this page.");
  availability("Variables", "Variable creation APIs",
    !!figma.variables && typeof figma.variables.createVariable === "function" &&
      typeof figma.variables.createVariableCollection === "function",
    "Variable write APIs are available; read-only variable queries are tested above. No variable or collection was created or changed.");
  availability("Export", "Node export API",
    typeof figma.currentPage.exportAsync === "function" && (!sampleSceneNode || typeof sampleSceneNode.exportAsync === "function"),
    "exportAsync is available on the active page/sample node; an export was not generated to avoid unnecessary large output.");
  add("Mutation safety", "Document-changing and live-interaction workflows", "not-tested", false,
    "Actual page switching, create/delete, text/style/component/variable writes, selection-change delivery, and content export are not executed by this non-destructive self-test. Their API availability is shown above where inspectable.");
  var passed = checks.filter(function (x) { return x.status === "success" && x.level !== "availability"; }).length;
  var available = checks.filter(function (x) { return x.status === "success" && x.level === "availability"; }).length;
  var failed = checks.filter(function (x) { return x.status === "error"; }).length;
  var notTested = checks.filter(function (x) { return x.status === "not-tested"; }).length;
  figma.ui.postMessage({ type: "native-health-result", checks: checks, passed: passed, available: available,
    failed: failed, notTested: notTested, commandId: commandId || null, checkedAt: new Date().toISOString() });
}
figma.ui.onmessage = async function (message) {
  if (!message) return;
  if (message.type === "get-selection") sendSelection();
  if (message.type === "run-native-health-check") await runNativeApiHealthCheck(message.commandId);
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

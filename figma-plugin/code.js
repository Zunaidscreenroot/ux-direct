// STRICT SCOPE: reject every file except the exact allowlisted key before reading document pages.
// STRICT SCOPE: plugin entry runs only after the exact approved Figma file key matches.
var UXD_ALLOWED_FILE_NAME = "Zunaid_Workspace";
var UXD_ALLOWED_FILE_KEY = "QJhcsebwscpdMJDNh9UsYS";
var UXD_API_TEST_LAB_PAGE = "UXD API Test Lab";
var UXD_NATIVE_API_PROBE_WAITERS = Object.create(null);
var UXD_HEALTH_CHECK_RUNNING = false;
var UXD_HEALTH_CHECK_PENDING_COMMAND_IDS = [];
var UXD_HEALTH_CHECK_LAST_REPORT = null;
var UXD_HEALTH_TEST_TIMEOUT_MS = 15000;
function assertUxDirectFileScope(actionName) {
  var key = "";
  try { key = typeof figma.fileKey === "string" ? figma.fileKey : ""; } catch (_) {}
  if (!UXD_ALLOWED_FILE_KEY || !key || key !== UXD_ALLOWED_FILE_KEY) {
    var message = "UX Direct blocked " + (actionName || "the operation") + ": current file key is not allowlisted.";
    try { figma.closePlugin(message); } catch (_) {}
    throw new Error(message);
  }
  return true;
}
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
function serializeNodeForAI(node, depth, budget) {
  if (!node || budget.count >= 180 || depth > 5) return null;
  budget.count += 1;
  var out = { id: node.id, name: node.name, type: node.type, visible: node.visible };
  ["x","y","width","height","rotation","opacity"].forEach(function (key) {
    if (typeof node[key] === "number" && Number.isFinite(node[key])) out[key] = Math.round(node[key] * 100) / 100;
  });
  if (node.type === "TEXT") {
    out.characters = String(node.characters || "").slice(0, 1200);
    try { if (typeof node.fontSize === "number") out.fontSize = node.fontSize; } catch (_) {}
    try { if (typeof node.textAlignHorizontal === "string") out.textAlignHorizontal = node.textAlignHorizontal; } catch (_) {}
    try { if (node.fontName && typeof node.fontName === "object") out.fontName = { family: node.fontName.family, style: node.fontName.style }; } catch (_) {}
  }
  ["fills","strokes"].forEach(function (key) {
    try {
      var paints = node[key];
      if (Array.isArray(paints)) out[key] = paints.slice(0, 3).map(function (paint) {
        var p = { type: paint.type, visible: paint.visible, opacity: paint.opacity };
        if (paint.color) p.color = { r: paint.color.r, g: paint.color.g, b: paint.color.b };
        if (paint.gradientStops) p.gradientStops = paint.gradientStops.slice(0, 4);
        return p;
      });
    } catch (_) {}
  });
  ["layoutMode","primaryAxisAlignItems","counterAxisAlignItems","itemSpacing","paddingLeft","paddingRight","paddingTop","paddingBottom","clipsContent"].forEach(function (key) {
    try { if (node[key] !== undefined && (typeof node[key] === "string" || typeof node[key] === "number" || typeof node[key] === "boolean")) out[key] = node[key]; } catch (_) {}
  });
  if ("children" in node) {
    out.children = [];
    for (var i = 0; i < node.children.length && budget.count < 180; i++) {
      var child = serializeNodeForAI(node.children[i], depth + 1, budget);
      if (child) out.children.push(child);
    }
    if (node.children.length > out.children.length) out.childrenTruncated = true;
  }
  return out;
}
function getSelectionSummary() {
  assertUxDirectFileScope("reading selection metadata");
  var budget = { count: 0 };
  return figma.currentPage.selection.slice(0, 12).map(function (node) {
    return {
      id: node.id, name: node.name, type: node.type, visible: node.visible,
      width: typeof node.width === "number" ? node.width : undefined,
      height: typeof node.height === "number" ? node.height : undefined,
      childCount: "children" in node ? node.children.length : undefined,
      tree: serializeNodeForAI(node, 0, budget)
    };
  });
}
function isDescendantOfSelection(node, selectedIds) {
  var current = node;
  while (current) {
    if (selectedIds.indexOf(current.id) >= 0) return true;
    current = current.parent;
  }
  return false;
}
function parseHexColor(value) {
  var hex = String(value || "").replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) throw new Error("Color must be a six-digit hex value.");
  return { r: parseInt(hex.slice(0,2),16)/255, g: parseInt(hex.slice(2,4),16)/255, b: parseInt(hex.slice(4,6),16)/255 };
}
async function executeDesignOperations(payload) {
  assertUxDirectFileScope("execute design operations");
  var selected = figma.currentPage.selection.slice(0, 12);
  if (!selected.length) throw new Error("Select a frame or layer before asking UX Direct to edit it.");
  var selectedIds = selected.map(function (node) { return node.id; });
  var operations = Array.isArray(payload && payload.operations) ? payload.operations.slice(0, 12) : [];
  if (!operations.length) throw new Error("The model did not provide any supported operations.");
  var results = [];
  for (var i = 0; i < operations.length; i++) {
    assertUxDirectFileScope("design operation " + (i + 1));
    var op = operations[i] || {};
    var node = op.targetId ? figma.getNodeById(String(op.targetId)) : null;
    if (node && !isDescendantOfSelection(node, selectedIds)) throw new Error("Blocked operation: target is outside the current selection.");
    if (op.action === "rename-node") {
      if (!node || typeof op.name !== "string" || !op.name.trim()) throw new Error("rename-node requires a selected descendant and a name.");
      node.name = op.name.slice(0, 160); results.push({ action: op.action, targetId: node.id, status: "applied" });
    } else if (op.action === "update-text") {
      if (!node || node.type !== "TEXT" || typeof op.text !== "string") throw new Error("update-text requires a selected text layer and text.");
      var font = node.fontName;
      if (font === figma.mixed) font = { family: "Inter", style: "Regular" };
      await figma.loadFontAsync(font);
      assertUxDirectFileScope("update selected text");
      node.characters = op.text.slice(0, 2000);
      results.push({ action: op.action, targetId: node.id, status: "applied" });
    } else if (op.action === "set-fill") {
      if (!node || !("fills" in node) || !Array.isArray(node.fills)) throw new Error("set-fill requires a selected shape or frame.");
      node.fills = [{ type: "SOLID", color: parseHexColor(op.color), opacity: 1 }];
      results.push({ action: op.action, targetId: node.id, status: "applied" });
    } else if (op.action === "create-text") {
      var parent = op.parentId ? figma.getNodeById(String(op.parentId)) : selected[0];
      if (!parent || !isDescendantOfSelection(parent, selectedIds) || !("appendChild" in parent)) throw new Error("create-text parent must be the selected frame or one of its descendants.");
      var textNode = figma.createText();
      await figma.loadFontAsync({ family: "Inter", style: "Regular" });
      assertUxDirectFileScope("create selected text");
      textNode.fontName = { family: "Inter", style: "Regular" };
      textNode.characters = String(op.text || "New text").slice(0, 2000);
      textNode.name = String(op.name || "UX Direct text").slice(0, 160);
      textNode.fontSize = Math.min(96, Math.max(8, Number(op.fontSize) || 16));
      textNode.x = Math.max(0, Math.min(10000, Number(op.x) || 0));
      textNode.y = Math.max(0, Math.min(10000, Number(op.y) || 0));
      parent.appendChild(textNode);
      results.push({ action: op.action, targetId: textNode.id, status: "applied" });
    } else if (op.action === "create-rectangle") {
      var shapeParent = op.parentId ? figma.getNodeById(String(op.parentId)) : selected[0];
      if (!shapeParent || !isDescendantOfSelection(shapeParent, selectedIds) || !("appendChild" in shapeParent)) throw new Error("create-rectangle parent must be inside the selected frame.");
      var shape = figma.createRectangle();
      shape.name = String(op.name || "UX Direct shape").slice(0, 160);
      shape.resize(Math.min(4000, Math.max(1, Number(op.width) || 160)), Math.min(4000, Math.max(1, Number(op.height) || 48)));
      shape.x = Math.max(0, Math.min(10000, Number(op.x) || 0));
      shape.y = Math.max(0, Math.min(10000, Number(op.y) || 0));
      shape.fills = [{ type: "SOLID", color: parseHexColor(op.color || "#E5E7EB"), opacity: 1 }];
      shapeParent.appendChild(shape);
      results.push({ action: op.action, targetId: shape.id, status: "applied" });
    } else {
      throw new Error("Unsupported design operation: " + String(op.action || "unknown"));
    }
    assertUxDirectFileScope("verify design operation");
  }
  figma.ui.postMessage({ type: "design-operation-result", ok: true, results: results });
  sendSelection();
  return results;
}
function sendSelection() {
  assertUxDirectFileScope("sending Figma context");
  figma.ui.postMessage({ type: "scope-approved", fileKey: figma.fileKey });
  figma.ui.postMessage({ type: "selection", fileKey: figma.fileKey,
    pageName: figma.currentPage.name, selection: getSelectionSummary() });
}
var selectionChangeListenerRegistered = false;
figma.on("selectionchange", sendSelection);
selectionChangeListenerRegistered = true;
async function executeNativeApiHealthCheck() {
  var checks = [];
  var testPage = null;
  var harness = null;
  var storageKey = null;
  var healthPaintStyleId = null;
  var healthVariableCollectionId = null;
  var pngExportBytes = null;
  var selectionHandlerPaused = false;
  var cleanupErrors = [];

  function add(category, name, level, status, reason) {
    checks.push({ category: category, name: name, level: level, status: status,
      reason: reason || (status === "success" ? "Executed and verified" : "Operation failed") });
  }
  function assertLab(name) {
    assertUxDirectFileScope(name);
    if (!testPage || testPage.removed) {
      throw new Error("Blocked " + name + ": persistent UXD API Test Lab is missing.");
    }
    // Tests are allowed to target the loaded, inactive test page. Do not navigate
    // away from the page the user is working on.
    if (!figma.root.children.some(function (page) { return page.id === testPage.id; })) {
      throw new Error("Blocked " + name + ": test page is not inside the allowlisted document.");
    }
  }
  function mutateLab(name, fn) {
    assertLab(name);
    var value = fn();
    assertUxDirectFileScope(name + " complete");
    return value;
  }
  async function mutateLabAsync(name, fn) {
    assertLab(name);
    var value = await fn();
    assertLab(name + " complete");
    return value;
  }
  function mutateFile(name, fn) {
    assertUxDirectFileScope(name);
    var value = fn();
    assertUxDirectFileScope(name + " complete");
    return value;
  }
  async function mutateFileAsync(name, fn) {
    assertUxDirectFileScope(name);
    var value = await fn();
    assertUxDirectFileScope(name + " complete");
    return value;
  }
  async function runTest(category, name, fn, needsLab) {
    var timeoutHandle = null;
    try {
      assertUxDirectFileScope(name);
      if (needsLab !== false) assertLab(name);
      figma.ui.postMessage({ type: "native-health-progress", category: category, name: name,
        text: "Testing " + name + "…", startedAt: new Date().toISOString() });
      var operation = Promise.resolve().then(fn);
      var operationResult = await Promise.race([
        operation,
        new Promise(function (_, reject) {
          timeoutHandle = setTimeout(function () {
            var error = new Error("API test timed out after " + (UXD_HEALTH_TEST_TIMEOUT_MS / 1000) + " seconds. Suite stopped to avoid overlapping document mutations.");
            error.code = "UXD_HEALTH_TEST_TIMEOUT";
            reject(error);
          }, UXD_HEALTH_TEST_TIMEOUT_MS);
        })
      ]);
      assertUxDirectFileScope(name + " verification");
      if (needsLab !== false) assertLab(name + " verification");
      add(category, name, "functional", "success",
        operationResult && operationResult.uxdResultReason
          ? operationResult.uxdResultReason
          : "Actual API operation executed and verified inside the allowlisted file.");
      figma.ui.postMessage({ type: "native-health-progress", category: category, name: name,
        text: "Passed: " + name, completedAt: new Date().toISOString() });
      return true;
    } catch (error) {
      add(category, name, "functional", "error", error && error.message ? error.message : String(error));
      if (error && error.code === "UXD_HEALTH_TEST_TIMEOUT") {
        figma.ui.postMessage({ type: "native-health-progress", category: category, name: name,
          text: "Stopped: " + name + " exceeded the safe test timeout.", failedAt: new Date().toISOString() });
        throw error;
      }
      figma.ui.postMessage({ type: "native-health-progress", category: category, name: name,
        text: "Failed: " + name, failedAt: new Date().toISOString() });
      return false;
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    }
  }
  function findNodeByName(root, name, type) {
    if (!root) return null;
    if (root.name === name && (!type || root.type === type)) return root;
    if (!("children" in root)) return null;
    var children = root.children;
    for (var i = 0; i < children.length; i++) {
      var found = findNodeByName(children[i], name, type);
      if (found) return found;
    }
    return null;
  }
  function createNode(factory, name, parent) {
    var targetParent = parent || harness || testPage;
    var node = name ? findNodeByName(targetParent, name) : null;
    var reused = !!node;
    if (!node) {
      node = mutateLab("create " + name, factory);
      // Reparent the fresh node immediately, before any further mutation or await.
      if (targetParent && node.parent !== targetParent) {
        mutateLab("attach " + name, function () { targetParent.appendChild(node); });
      }
      if (name) mutateLab("name " + name, function () { node.name = name; });
    }
    return node;
  }
  function rect(name, parent) {
    return createNode(function () { return figma.createRectangle(); }, name || "UXD test rectangle", parent || harness);
  }
  function ellipse(name, parent) {
    return createNode(function () { return figma.createEllipse(); }, name || "UXD test ellipse", parent || harness);
  }
  function availability(category, name, ok, reason) {
    add(category, name, "availability", ok ? "success" : "error",
      reason || (ok ? "API is exposed but intentionally not executed." : "API is unavailable in this runtime."));
  }
  function cleanupProgress(text) {
    figma.ui.postMessage({ type: "native-health-progress", text: text });
  }
  async function postResult() {
    try { assertUxDirectFileScope("report health-check results"); } catch (_) { return; }
    var passed = checks.filter(function (x) { return x.status === "success" && x.level !== "availability"; }).length;
    var available = checks.filter(function (x) { return x.status === "success" && x.level === "availability"; }).length;
    var failed = checks.filter(function (x) { return x.status === "error"; }).length;
    var notTested = checks.filter(function (x) { return x.status === "not-tested"; }).length;
    var report = { type: "native-health-result", checks: checks, passed: passed,
      available: available, failed: failed, notTested: notTested, checkedAt: new Date().toISOString() };
    UXD_HEALTH_CHECK_LAST_REPORT = report;
    var commandIds = UXD_HEALTH_CHECK_PENDING_COMMAND_IDS.splice(0);
    if (!commandIds.length) commandIds = [null];
    commandIds.forEach(function (id) {
      figma.ui.postMessage(Object.assign({}, report, { commandId: id || null }));
    });
  }

  try {
    assertUxDirectFileScope("starting native API health check");
  } catch (error) {
    add("Security", "Revalidate exact Figma file key", "functional", "error", error && error.message ? error.message : String(error));
    await postResult();
    return;
  }

  add("Events", "Receive selection-change event from inactive page", "not-tested", "not-tested",
    "Not tested intentionally: selectionchange is tied to the current page. Testing the UXD API Test Lab page in the background would require switching away from the user's active page.");
  availability("Events", "Register/remove listener with figma.off", typeof figma.off === "function",
    "Availability only; verifying removal requires triggering the event, which this check skips to preserve the user's active page.");

  var labReady = await runTest("Test isolation", "Find and reuse UXD API Test Lab page", async function () {
    var pages = mutateFile("locate test lab in current file", function () { return figma.root.children; });
    testPage = pages.find(function (page) { return page.name === UXD_API_TEST_LAB_PAGE; }) || null;
    var newlyCreated = false;
    if (!testPage) {
      testPage = mutateFile("create isolated test page", function () { return figma.createPage(); });
      mutateFile("name isolated test page", function () { testPage.name = UXD_API_TEST_LAB_PAGE; });
      newlyCreated = true;
    }
    // Load the dedicated page directly; never change figma.currentPage.
    await mutateFileAsync("load persistent test lab", function () { return testPage.loadAsync(); });
    if (!figma.root.children.some(function (page) { return page.id === testPage.id; })) {
      throw new Error("UXD API Test Lab is not attached to the approved document.");
    }
    return { uxdResultReason: newlyCreated ? "Created the dedicated test page once without navigating to it." : "Reused and loaded the existing dedicated test page without navigating to it." };
  }, false);

  if (!labReady || !testPage) {
    add("Plugin lifecycle", "figma.closePlugin", "not-tested", "not-tested",
      "Not tested intentionally: invoking it would terminate the active plugin session.");
    add("External navigation", "figma.openExternal", "not-tested", "not-tested",
      "Not tested intentionally: invoking it would open an external browser.");
    add("Library", "Team Library", "not-tested", "not-tested",
      "Not tested intentionally: team-library APIs are out of scope; no teamlibrary permission, shared-library lookup, or import is enabled.");
    await postResult();
    return;
  }

  // Keep a small visible fixture set on the lab page so the owner and future agents have known nodes to inspect.
  await runTest("Test isolation", "Prepare reusable shape/text/component fixtures", async function () {
    var fixtureName = "__UXD API Test Fixtures";
    var fixture = testPage.children.find(function (node) { return node.type === "FRAME" && node.name === fixtureName; }) || null;
    var fixtureNames = [
      ["FRAME", "Fixture Frame"], ["RECTANGLE", "Fixture Rectangle"],
      ["ELLIPSE", "Fixture Ellipse"], ["LINE", "Fixture Line"],
      ["TEXT", "Fixture Text"], ["COMPONENT", "Fixture Component"],
      ["VECTOR", "Fixture Vector"]
    ];
    var fixturesAlreadyReady = !!fixture && fixtureNames.every(function (expected) {
      return fixture.children.some(function (node) { return node.type === expected[0] && node.name === expected[1]; });
    });
    if (fixturesAlreadyReady) {
      var readyComponent = fixture.children.find(function (node) { return node.type === "COMPONENT" && node.name === "Fixture Component"; });
      if (readyComponent && readyComponent.children.some(function (node) { return node.name === "Fixture Component Child"; })) {
        return { uxdResultReason: "Reused the persistent shape/text/component fixture set; no fixtures were recreated." };
      }
    }
    if (!fixture) {
      fixture = mutateLab("create persistent fixture frame", function () { return figma.createFrame(); });
      mutateLab("name persistent fixture frame", function () { fixture.name = fixtureName; });
      mutateLab("size persistent fixture frame", function () { fixture.resize(720, 420); });
      mutateLab("style persistent fixture frame", function () {
        fixture.fills = [{ type: "SOLID", color: { r: 0.985, g: 0.99, b: 1 } }];
      });
    }
    function ensureFixture(type, name, factory) {
      var node = fixture.children.find(function (item) { return item.type === type && item.name === name; }) || null;
      if (!node) {
        node = mutateLab("create persistent fixture " + name, factory);
        mutateLab("name persistent fixture " + name, function () { node.name = name; });
        mutateLab("attach persistent fixture " + name, function () { fixture.appendChild(node); });
      }
      return node;
    }
    var sampleFrame = ensureFixture("FRAME", "Fixture Frame", function () { return figma.createFrame(); });
    mutateLab("size fixture frame", function () { sampleFrame.resize(180, 110); });
    mutateLab("position fixture frame", function () { sampleFrame.x = 20; sampleFrame.y = 20; });
    var sampleRect = ensureFixture("RECTANGLE", "Fixture Rectangle", function () { return figma.createRectangle(); });
    mutateLab("size fixture rectangle", function () { sampleRect.resize(100, 64); });
    mutateLab("position fixture rectangle", function () { sampleRect.x = 230; sampleRect.y = 24; });
    mutateLab("fill fixture rectangle", function () { sampleRect.fills = [{ type: "SOLID", color: { r: 0.18, g: 0.38, b: 0.9 } }]; });
    var sampleEllipse = ensureFixture("ELLIPSE", "Fixture Ellipse", function () { return figma.createEllipse(); });
    mutateLab("size fixture ellipse", function () { sampleEllipse.resize(72, 52); });
    mutateLab("position fixture ellipse", function () { sampleEllipse.x = 360; sampleEllipse.y = 24; });
    var sampleLine = ensureFixture("LINE", "Fixture Line", function () { return figma.createLine(); });
    mutateLab("position fixture line", function () { sampleLine.x = 455; sampleLine.y = 35; });
    var sampleText = ensureFixture("TEXT", "Fixture Text", function () { return figma.createText(); });
    var fixtureFont = sampleText.fontName;
    if (!fixtureFont || fixtureFont === figma.mixed) throw new Error("Fixture text has no single font.");
    await mutateLabAsync("load fixture text font", function () { return figma.loadFontAsync(fixtureFont); });
    if (sampleText.characters !== "UXD API Fixture") {
      mutateLab("write fixture text", function () { sampleText.characters = "UXD API Fixture"; });
    }
    mutateLab("position fixture text", function () { sampleText.x = 20; sampleText.y = 160; });
    var sampleComponent = ensureFixture("COMPONENT", "Fixture Component", function () { return figma.createComponent(); });
    mutateLab("size fixture component", function () { sampleComponent.resize(140, 80); });
    mutateLab("position fixture component", function () { sampleComponent.x = 20; sampleComponent.y = 225; });
    if (!sampleComponent.children.some(function (node) { return node.name === "Fixture Component Child"; })) {
      var child = mutateLab("create fixture component child", function () { return figma.createRectangle(); });
      mutateLab("name fixture component child", function () { child.name = "Fixture Component Child"; });
      mutateLab("size fixture component child", function () { child.resize(56, 36); });
      mutateLab("attach fixture component child", function () { sampleComponent.appendChild(child); });
    }
    var sampleVector = ensureFixture("VECTOR", "Fixture Vector", function () { return figma.createVector(); });
    mutateLab("position fixture vector", function () { sampleVector.x = 230; sampleVector.y = 130; });
  });
  // Avoid sending temporary test-page selections to backend telemetry during the suite.
  try {
    assertLab("pause selection context listener");
    figma.off("selectionchange", sendSelection);
    selectionHandlerPaused = true;
  } catch (error) {
    add("Events", "Pause selection context messaging", "functional", "error", error && error.message ? error.message : String(error));
  }

  try {
    await runTest("Test isolation", "Reuse persistent API test container", async function () {
      var harnessName = "__UXD API TEST RUN";
      var existingHarness = testPage.children.find(function (node) { return node.type === "FRAME" && node.name === harnessName; }) || null;
      if (existingHarness) {
        harness = existingHarness;
        return { uxdResultReason: "Reused the persistent test container from the first run." };
      }
      harness = createNode(function () { return figma.createFrame(); }, harnessName, null);
      mutateLab("resize test container", function () { harness.resize(640, 480); });
      mutateLab("style test container", function () {
        harness.fills = [{ type: "SOLID", color: { r: 0.96, g: 0.97, b: 0.99 } }];
      });
    });

    await runTest("Security", "Confirm test page is contained by approved file", async function () {
      if (figma.fileKey !== UXD_ALLOWED_FILE_KEY) throw new Error("Live file key no longer matches the allowlist.");
      if (!figma.root.children.some(function (page) { return page.id === testPage.id; })) {
        throw new Error("Test page is not a child of the approved document.");
      }
    });

    await runTest("Node inspection", "Resolve a node by async ID lookup", async function () {
      var found = await mutateLabAsync("resolve test node using getNodeByIdAsync", function () { return figma.getNodeByIdAsync(harness.id); });
      if (!found || found.id !== harness.id) throw new Error("getNodeByIdAsync failed to resolve the test frame.");
    });
    await runTest("Node inspection", "Verify legacy getNodeById restriction in dynamic-page mode", async function () {
      if (typeof figma.getNodeById !== "function") {
        // The deprecated sync method may be absent; the async ID lookup above is the supported path.
        return;
      }
      var expectedBlock = false;
      try {
        assertLab("verify dynamic-page sync lookup restriction");
        figma.getNodeById(harness.id);
      } catch (error) {
        var message = error && error.message ? error.message : String(error);
        if (/dynamic-page|deprecated|async/i.test(message)) expectedBlock = true;
        else throw error;
      }
      if (!expectedBlock) throw new Error("Legacy getNodeById was not blocked despite dynamic-page mode; review manifest/API compatibility.");
    });
    await runTest("Viewport", "Read viewport zoom and bounds", async function () {
      var bounds = mutateLab("read viewport bounds", function () { return figma.viewport.bounds; });
      var zoom = mutateLab("read viewport zoom", function () { return figma.viewport.zoom; });
      if (!bounds || typeof zoom !== "number" || zoom <= 0) throw new Error("Viewport bounds or zoom were invalid.");
    });

    await runTest("Page navigation", "Verify inactive Test Lab remains accessible", async function () {
      var pages = mutateFile("verify persistent test lab page", function () { return figma.root.children; });
      if (!pages.some(function (page) { return page.id === testPage.id && page.name === UXD_API_TEST_LAB_PAGE; })) {
        throw new Error("Persistent UXD API Test Lab page is missing from the approved file.");
      }
      if (!Array.isArray(testPage.children)) throw new Error("Persistent Test Lab page children are not available after loadAsync.");
      return { uxdResultReason: "Verified the persistent page while leaving the user's active page unchanged." };
    }, false);

    await runTest("Shapes", "Create and resize frame", async function () {
      var node = createNode(function () { return figma.createFrame(); }, "UXD API test frame", harness);
      mutateLab("resize test frame", function () { node.resize(120, 90); });
      if (node.width !== 120 || node.height !== 90) throw new Error("Frame dimensions did not persist.");
    });
    await runTest("Shapes", "Create rectangle and edit fill/opacity", async function () {
      var node = rect("UXD API test rectangle");
      mutateLab("resize test rectangle", function () { node.resize(80, 60); });
      mutateLab("set rectangle fill", function () { node.fills = [{ type: "SOLID", color: { r: 0.18, g: 0.38, b: 0.9 } }]; });
      mutateLab("set rectangle opacity", function () { node.opacity = 0.6; });
      var readBackFills = node.fills === figma.mixed ? null : node.fills;
      if (Math.abs(node.opacity - 0.6) > 0.001) {
        throw new Error("Rectangle opacity mismatch: expected 0.6, got " + node.opacity + ".");
      }
      if (!readBackFills || readBackFills.length !== 1) {
        throw new Error("Rectangle fill mismatch: expected 1 fill, got " + (readBackFills ? readBackFills.length : "mixed") + ".");
      }
    });
    await runTest("Shapes", "Create ellipse", async function () {
      var node = ellipse("UXD API test ellipse");
      mutateLab("resize test ellipse", function () { node.resize(70, 50); });
      if (node.type !== "ELLIPSE") throw new Error("Expected an ELLIPSE node.");
    });
    await runTest("Shapes", "Create line", async function () {
      var node = createNode(function () { return figma.createLine(); }, "UXD API test line", harness);
      if (node.type !== "LINE") throw new Error("Expected a LINE node.");
    });
    await runTest("Shapes", "Create polygon and update point count", async function () {
      var node = createNode(function () { return figma.createPolygon(); }, "UXD API test polygon", harness);
      mutateLab("set polygon point count", function () { node.pointCount = 5; });
      if (node.pointCount !== 5) throw new Error("Polygon point count did not persist.");
    });
    await runTest("Shapes", "Create star and update point count", async function () {
      var node = createNode(function () { return figma.createStar(); }, "UXD API test star", harness);
      mutateLab("set star point count", function () { node.pointCount = 5; });
      if (node.type !== "STAR" || node.pointCount !== 5) throw new Error("Star API did not persist.");
    });
    await runTest("Shapes", "Create vector node", async function () {
      var node = createNode(function () { return figma.createVector(); }, "UXD API test vector", harness);
      if (node.type !== "VECTOR") throw new Error("Expected a VECTOR node.");
    });
    await runTest("Shapes", "Resolve a persistent node by async ID", async function () {
      var node = rect("UXD API removable rectangle");
      var found = await mutateLabAsync("resolve persistent test node", function () { return figma.getNodeByIdAsync(node.id); });
      if (!found || found.id !== node.id) throw new Error("Persistent node could not be resolved after reuse.");
      if (typeof node.remove !== "function") throw new Error("Node remove API is not exposed.");
      return { uxdResultReason: "Resolved a persistent node and verified the remove API is exposed; no node was deleted." };
    });

    await runTest("Text", "Create text, load font, write characters", async function () {
      var node = createNode(function () { return figma.createText(); }, "UXD API test text", harness);
      var fontName = node.fontName;
      if (!fontName || fontName === figma.mixed) throw new Error("Text node did not expose a single font.");
      await mutateLabAsync("load font for test text", function () { return figma.loadFontAsync(fontName); });
      if (node.characters !== "UX Direct API test") mutateLab("write test characters", function () { node.characters = "UX Direct API test"; });
      if (node.characters !== "UX Direct API test") throw new Error("Text write did not persist.");
    });

    await runTest("Node actions", "Clone node and verify properties", async function () {
      var source = rect("UXD clone source");
      if (source.width !== 84 || source.height !== 48) {
        mutateLab("size clone source", function () { source.resize(84, 48); });
      }
      var cloneName = "__UXD CLONE RESULT";
      var clone = findNodeByName(harness, cloneName, "RECTANGLE");
      if (!clone) {
        clone = mutateLab("clone test rectangle", function () { return source.clone(); });
        if (clone.parent !== harness) mutateLab("attach cloned test rectangle", function () { harness.appendChild(clone); });
        mutateLab("name cloned test rectangle", function () { clone.name = cloneName; });
      }
      if (clone.id === source.id || clone.type !== "RECTANGLE") throw new Error("clone() did not return a distinct rectangle.");
      if (clone.width !== 84 || clone.height !== 48) mutateLab("resize cloned test rectangle", function () { clone.resize(84, 48); });
      if (clone.width !== source.width || clone.height !== source.height) throw new Error("Clone dimensions did not match the source.");
    });

    await runTest("Layout and styling", "Apply frame auto layout", async function () {
      var frame = createNode(function () { return figma.createFrame(); }, "__UXD AUTO LAYOUT FRAME", harness);
      var first = rect("UXD auto-layout rectangle", frame);
      var second = ellipse("UXD auto-layout ellipse", frame);
      mutateLab("set frame horizontal auto layout", function () {
        frame.layoutMode = "HORIZONTAL";
        frame.itemSpacing = 12;
      });
      if (frame.layoutMode !== "HORIZONTAL") throw new Error("Frame layout mode did not persist.");
      if (frame.itemSpacing !== 12) throw new Error("Frame item spacing did not persist.");
      if (first.parent !== frame || second.parent !== frame) throw new Error("Auto-layout children were not attached to the frame.");
    });

    await runTest("Layout and styling", "Rotate node and set constraints", async function () {
      var node = rect("UXD rotate and constraints probe");
      mutateLab("set probe rotation", function () { node.rotation = 17; });
      mutateLab("set probe constraints", function () { node.constraints = { horizontal: "MIN", vertical: "MIN" }; });
      if (Math.abs(node.rotation - 17) > 0.001) throw new Error("Node rotation did not persist.");
      if (node.constraints.horizontal !== "MIN" || node.constraints.vertical !== "MIN") {
        throw new Error("Node constraints did not persist.");
      }
    });

    await runTest("Text", "Set and verify text range font size", async function () {
      var node = createNode(function () { return figma.createText(); }, "UXD text range font-size probe", harness);
      var fontName = node.fontName;
      if (!fontName || fontName === figma.mixed) throw new Error("Text node did not expose a single font.");
      await mutateLabAsync("load font for range-size probe", function () { return figma.loadFontAsync(fontName); });
      if (node.characters !== "UX Direct range text") {
        mutateLab("write range-size probe text", function () { node.characters = "UX Direct range text"; });
      }
      mutateLab("set text range font size", function () { node.setRangeFontSize(0, node.characters.length, 18); });
      var fontSize = node.getRangeFontSize(0, node.characters.length);
      if (fontSize !== 18) throw new Error("Text range font size mismatch: expected 18, got " + fontSize + ".");
    });

    await runTest("Export", "Export shape to SVG", async function () {
      var node = rect("UXD SVG export probe");
      if (node.width !== 48 || node.height !== 36) mutateLab("size SVG export probe", function () { node.resize(48, 36); });
      var svg = await mutateLabAsync("export test shape to SVG string", function () {
        return node.exportAsync({ format: "SVG_STRING" });
      });
      if (typeof svg !== "string" || !svg.length) throw new Error("SVG export produced no string.");
      if (svg.indexOf("<svg") === -1) throw new Error("SVG export did not contain an SVG root element.");
    });

    await runTest("Layout and styling", "Reorder nodes with insertChild", async function () {
      var first = rect("__UXD ORDER FIRST");
      var second = ellipse("__UXD ORDER SECOND");
      var firstIndex = harness.children.indexOf(first);
      var secondIndex = harness.children.indexOf(second);
      if (firstIndex < 0 || secondIndex < 0) throw new Error("Persistent reorder fixtures were not found in the test container.");
      mutateLab("reorder persistent test nodes", function () {
        harness.insertChild(harness.children.indexOf(first), second);
      });
      if (harness.children.indexOf(second) >= harness.children.indexOf(first)) {
        throw new Error("insertChild did not move the second node before the first.");
      }
    });

    await runTest("Layout and styling", "Group two persistent test nodes", async function () {
      var groupName = "__UXD GROUP RESULT";
      var existingGroup = findNodeByName(harness, groupName, "GROUP");
      if (existingGroup) {
        if (existingGroup.children.length !== 2) throw new Error("Persistent group fixture no longer contains two children.");
        return { uxdResultReason: "Reused the group created on the first run; did not create another group." };
      }
      var a = rect("UXD group item A"), b = ellipse("UXD group item B");
      mutateLab("position group item A", function () { a.x = 5; a.y = 5; });
      mutateLab("position group item B", function () { b.x = 35; b.y = 25; });
      var group = mutateLab("group test nodes", function () { return figma.group([a, b], harness); });
      mutateLab("name persistent test group", function () { group.name = groupName; });
      if (group.type !== "GROUP" || group.children.length !== 2) throw new Error("Group did not contain both nodes.");
    });
    await runTest("Layout and styling", "Reuse persistent flattened vector", async function () {
      var vectorName = "__UXD FLATTEN RESULT";
      var existingVector = findNodeByName(harness, vectorName, "VECTOR");
      if (existingVector) {
        if (existingVector.type !== "VECTOR") throw new Error("Persistent flatten fixture is invalid.");
        return { uxdResultReason: "Reused the vector created on the first run; flatten is not rerun to create duplicates." };
      }
      var a = rect("UXD flatten item A"), b = ellipse("UXD flatten item B");
      mutateLab("position flatten item", function () { b.x = 25; b.y = 25; });
      var vector = mutateLab("flatten test nodes", function () { return figma.flatten([a, b], harness); });

      mutateLab("name persistent flattened vector", function () { vector.name = vectorName; });
      if (vector.type !== "VECTOR") throw new Error("Flatten did not return a VECTOR node.");
    });
    var booleanOperations = [
      { name: "union", fn: function (nodes, parent) { return figma.union(nodes, parent); } },
      { name: "intersect", fn: function (nodes, parent) { return figma.intersect(nodes, parent); } },
      { name: "subtract", fn: function (nodes, parent) { return figma.subtract(nodes, parent); } },
      { name: "exclude", fn: function (nodes, parent) { return figma.exclude(nodes, parent); } }
    ];
    for (var opIndex = 0; opIndex < booleanOperations.length; opIndex++) {
      var operation = booleanOperations[opIndex];
      await runTest("Layout and styling", "Verify persistent " + operation.name + " boolean fixture", async function () {
        var resultName = "__UXD BOOLEAN RESULT " + operation.name;
        var existingResult = findNodeByName(harness, resultName, "BOOLEAN_OPERATION");
        if (existingResult) {
          return { uxdResultReason: "Reused the persistent " + operation.name + " result created on the first run." };
        }
        var a = rect("UXD boolean A"), b = ellipse("UXD boolean B");
        mutateLab("position boolean-test node", function () { b.x = 25; });
        var result = mutateLab("execute boolean operation", function () { return operation.fn([a, b], harness); });

        mutateLab("name persistent boolean result", function () { result.name = resultName; });
        if (result.type !== "BOOLEAN_OPERATION") throw new Error(operation.name + " did not return a BOOLEAN_OPERATION.");
      });
    }

    await runTest("Components", "Reuse persistent component and instance", async function () {
      var component = createNode(function () { return figma.createComponent(); }, "UXD API test component", harness);
      if (component.width !== 100 || component.height !== 60) mutateLab("size persistent test component", function () { component.resize(100, 60); });
      rect("UXD component child", component);
      var instanceName = "UXD API test component instance";
      var instance = findNodeByName(harness, instanceName, "INSTANCE");
      if (!instance) {
        instance = mutateLab("create test component instance", function () { return component.createInstance(); });

        mutateLab("name persistent test instance", function () { instance.name = instanceName; });
        if (instance.parent !== harness) mutateLab("attach persistent test instance", function () { harness.appendChild(instance); });
      }
      var main = await mutateLabAsync("resolve instance main component", function () { return instance.getMainComponentAsync(); });
      if (!main || main.id !== component.id) throw new Error("Instance did not resolve to its main component.");
    });
    await runTest("Components", "Reuse component created from frame", async function () {
      var componentName = "__UXD FRAME TO COMPONENT RESULT";
      var existingComponent = findNodeByName(harness, componentName, "COMPONENT");
      if (existingComponent) {
        return { uxdResultReason: "Reused the component produced on the first run; did not convert a new frame." };
      }
      var frame = createNode(function () { return figma.createFrame(); }, "UXD frame to component", harness);
      rect("UXD component source child", frame);
      var component = mutateLab("convert frame to component", function () { return figma.createComponentFromNode(frame); });

      mutateLab("name persistent frame component", function () { component.name = componentName; });
      if (component.type !== "COMPONENT") throw new Error("createComponentFromNode did not produce a component.");
    });
    await runTest("Components", "Reuse persistent component variant set", async function () {
      var setName = "__UXD COMPONENT VARIANT SET";
      var existingSet = findNodeByName(harness, setName, "COMPONENT_SET");
      if (existingSet) {
        if (existingSet.children.length !== 2) throw new Error("Persistent component set no longer contains two variants.");
        return { uxdResultReason: "Reused the variant set created on the first run." };
      }
      var a = createNode(function () { return figma.createComponent(); }, "UXD variant A", harness);
      var b = createNode(function () { return figma.createComponent(); }, "UXD variant B", harness);
      mutateLab("resize variant A", function () { a.resize(100, 60); });
      mutateLab("resize variant B", function () { b.resize(100, 60); });
      var set = mutateLab("combine variants", function () { return figma.combineAsVariants([a, b], harness); });

      mutateLab("name persistent component set", function () { set.name = setName; });
      if (set.type !== "COMPONENT_SET" || set.children.length !== 2) throw new Error("Component set did not contain both variants.");
    });

    await runTest("Variables", "Reuse persistent health variable collection", async function () {
      if (!figma.variables || typeof figma.variables.createVariableCollection !== "function" || typeof figma.variables.createVariable !== "function") {
        throw new Error("Variable write APIs are unavailable.");
      }
      var allCollections = await mutateLabAsync("read variable collections for reuse", function () { return figma.variables.getLocalVariableCollectionsAsync(); });
      var collectionName = "__UXD API HEALTH VARIABLES";
      var collection = allCollections.find(function (item) { return item.name === collectionName; }) || null;
      if (!collection) collection = mutateLab("create persistent health variable collection", function () {
        return figma.variables.createVariableCollection(collectionName);
      });
      healthVariableCollectionId = collection.id;
      var allVariables = await mutateLabAsync("read variables for reuse", function () { return figma.variables.getLocalVariablesAsync(); });
      var variable = allVariables.find(function (item) { return item.name === "probe/color" && item.variableCollectionId === collection.id; }) || null;
      if (!variable) variable = mutateLab("create persistent health variable", function () {
        return figma.variables.createVariable("probe/color", collection, "COLOR");
      });
      mutateLab("write persistent health variable", function () {
        variable.setValueForMode(collection.defaultModeId, { r: 0.2, g: 0.4, b: 0.6 });
      });
      var loaded = await mutateLabAsync("read persistent health variable", function () { return figma.variables.getVariableByIdAsync(variable.id); });
      var colorValue = loaded && loaded.valuesByMode && loaded.valuesByMode[collection.defaultModeId];
      if (!colorValue || Math.abs(colorValue.r - 0.2) > 0.001) {
        throw new Error("Persistent variable read-back mismatch: expected red channel 0.2, got " + (colorValue ? colorValue.r : "missing") + ".");
      }
      return { uxdResultReason: "Reused a named variable collection and variable; nothing was deleted." };
    });
    await runTest("Variables", "Read local variables and collections", async function () {
      var variables = await mutateLabAsync("read local variable list", function () { return figma.variables.getLocalVariablesAsync(); });
      var collections = await mutateLabAsync("read local variable collection list", function () { return figma.variables.getLocalVariableCollectionsAsync(); });
      if (!Array.isArray(variables) || !Array.isArray(collections)) throw new Error("Local variable APIs returned invalid results.");
    });

    await runTest("Storage", "Write/read persistent client-storage key", async function () {
      storageKey = "uxd.health.probe.persistent";
      await mutateLabAsync("write persistent client-storage key", function () { return figma.clientStorage.setAsync(storageKey, "uxd-test-value"); });
      var value = await mutateLabAsync("read persistent client-storage key", function () { return figma.clientStorage.getAsync(storageKey); });
      if (value !== "uxd-test-value") throw new Error("clientStorage returned a different value.");
      return { uxdResultReason: "Reused the fixed client-storage key; it was not deleted." };
    });

    await runTest("Export", "Export a temporary shape to PNG", async function () {
      var node = rect("UXD export probe");
      mutateLab("resize export probe", function () { node.resize(40, 32); });
      mutateLab("style export probe", function () { node.fills = [{ type: "SOLID", color: { r: 0.1, g: 0.3, b: 0.8 } }]; });
      var bytes = await mutateLabAsync("export test shape", function () {
        return node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
      });
      if (!bytes || !bytes.length) throw new Error("PNG export produced no bytes.");
      pngExportBytes = bytes;
    });

    await runTest("Plugin bridge", "Round-trip a probe through UI messaging", async function () {
      var probeId = "uxd-probe-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      var ack = new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          delete UXD_NATIVE_API_PROBE_WAITERS[probeId];
          reject(new Error("Plugin UI did not acknowledge the probe within 1.8 seconds."));
        }, 1800);
        UXD_NATIVE_API_PROBE_WAITERS[probeId] = function () { clearTimeout(timer); resolve(true); };
      });
      assertLab("send probe to plugin UI");
      figma.ui.postMessage({ type: "native-api-probe", probeId: probeId });
      await ack;
    });

    // Keep side-effectful/session UI APIs explicitly out of functional execution.
    add("Plugin lifecycle", "figma.closePlugin", "not-tested", "not-tested",
      "Not tested intentionally: invoking it would terminate the active plugin session.");
    add("External navigation", "figma.openExternal", "not-tested", "not-tested",
      "Not tested intentionally: invoking it would open an external browser.");
    availability("Notifications", "figma.notify", typeof figma.notify === "function",
      "Availability only; not invoked to avoid interrupting the user.");

    await runTest("Styles", "figma.getLocalPaintStylesAsync", async function () {
      var styles = await mutateFileAsync("read local paint styles", function () { return figma.getLocalPaintStylesAsync(); });
      if (!Array.isArray(styles)) throw new Error("Local paint styles API did not return an array.");
      var styleName = "__UXD API HEALTH PAINT STYLE";
      var style = styles.find(function (item) { return item.name === styleName; }) || null;
      if (!style) {
        style = mutateFile("create persistent health paint style", function () { return figma.createPaintStyle(); });
        mutateFile("name persistent health paint style", function () { style.name = styleName; });
        mutateFile("set persistent health paint style", function () {
          style.paints = [{ type: "SOLID", color: { r: 0.18, g: 0.38, b: 0.9 } }];
        });
        styles = await mutateFileAsync("verify local paint style list", function () { return figma.getLocalPaintStylesAsync(); });
      }
      if (!styles.some(function (item) { return item.id === style.id; })) {
        throw new Error("The persistent test paint style was not returned by getLocalPaintStylesAsync.");
      }
      healthPaintStyleId = style.id;
    });
    await runTest("Styles", "figma.getLocalTextStylesAsync", async function () {
      var styles = await mutateFileAsync("read local text styles", function () { return figma.getLocalTextStylesAsync(); });
      if (!Array.isArray(styles)) throw new Error("Local text styles API did not return an array.");
      var name = "__UXD API HEALTH TEXT STYLE";
      var style = styles.find(function (item) { return item.name === name; }) || null;
      if (!style) {
        style = mutateFile("create persistent health text style", function () { return figma.createTextStyle(); });
        mutateFile("name persistent health text style", function () { style.name = name; });
        styles = await mutateFileAsync("verify local text style list", function () { return figma.getLocalTextStylesAsync(); });
      }
      if (!styles.some(function (item) { return item.id === style.id; })) {
        throw new Error("The persistent test text style was not returned by getLocalTextStylesAsync.");
      }
    });
    await runTest("Styles", "figma.getLocalEffectStylesAsync", async function () {
      var styles = await mutateFileAsync("read local effect styles", function () { return figma.getLocalEffectStylesAsync(); });
      if (!Array.isArray(styles)) throw new Error("Local effect styles API did not return an array.");
      var name = "__UXD API HEALTH EFFECT STYLE";
      var style = styles.find(function (item) { return item.name === name; }) || null;
      if (!style) {
        style = mutateFile("create persistent health effect style", function () { return figma.createEffectStyle(); });
        mutateFile("name persistent health effect style", function () { style.name = name; });
        styles = await mutateFileAsync("verify local effect style list", function () { return figma.getLocalEffectStylesAsync(); });
      }
      if (!styles.some(function (item) { return item.id === style.id; })) {
        throw new Error("The persistent test effect style was not returned by getLocalEffectStylesAsync.");
      }
    });
    await runTest("Styles", "figma.getLocalGridStylesAsync", async function () {
      var styles = await mutateFileAsync("read local grid styles", function () { return figma.getLocalGridStylesAsync(); });
      if (!Array.isArray(styles)) throw new Error("Local grid styles API did not return an array.");
      var name = "__UXD API HEALTH GRID STYLE";
      var style = styles.find(function (item) { return item.name === name; }) || null;
      if (!style) {
        style = mutateFile("create persistent health grid style", function () { return figma.createGridStyle(); });
        mutateFile("name persistent health grid style", function () { style.name = name; });
        styles = await mutateFileAsync("verify local grid style list", function () { return figma.getLocalGridStylesAsync(); });
      }
      if (!styles.some(function (item) { return item.id === style.id; })) {
        throw new Error("The persistent test grid style was not returned by getLocalGridStylesAsync.");
      }
    });

    await runTest("Components", "Find component nodes with findAllWithCriteria", async function () {
      var components = harness.findAllWithCriteria({ types: ["COMPONENT"] });
      if (!Array.isArray(components)) throw new Error("Component criteria search returned an invalid result.");
      if (!components.some(function (node) { return node.type === "COMPONENT"; })) {
        throw new Error("No component fixture was found by the supported criteria search.");
      }
    });
    await runTest("Components", "Find component sets with findAllWithCriteria", async function () {
      var componentSets = harness.findAllWithCriteria({ types: ["COMPONENT_SET"] });
      if (!Array.isArray(componentSets)) throw new Error("Component-set criteria search returned an invalid result.");
      if (!componentSets.some(function (node) { return node.type === "COMPONENT_SET"; })) {
        throw new Error("No component-set fixture was found by the supported criteria search.");
      }
    });
    await runTest("Styles", "figma.getStyleByIdAsync", async function () {
      var styleId = healthPaintStyleId;
      if (!styleId) {
        var styles = await mutateFileAsync("find paint style for style ID probe", function () { return figma.getLocalPaintStylesAsync(); });
        var style = styles.find(function (item) { return item.name === "__UXD API HEALTH PAINT STYLE"; }) || null;
        if (!style) {
          style = mutateFile("create paint style for style ID probe", function () { return figma.createPaintStyle(); });
          mutateFile("name paint style for style ID probe", function () { style.name = "__UXD API HEALTH PAINT STYLE"; });
          mutateFile("set paint style for style ID probe", function () {
            style.paints = [{ type: "SOLID", color: { r: 0.18, g: 0.38, b: 0.9 } }];
          });
        }
        styleId = style.id;
        healthPaintStyleId = styleId;
      }
      var resolved = await mutateFileAsync("resolve local style by ID", function () { return figma.getStyleByIdAsync(styleId); });
      if (!resolved || resolved.id !== styleId) throw new Error("getStyleByIdAsync did not resolve the persistent paint style.");
    });
    await runTest("Document loading", "figma.loadAllPagesAsync", async function () {
      var before = mutateFile("snapshot pages before loading", function () { return figma.root.children.map(function (page) { return page.id; }); });
      await mutateFileAsync("load all document pages", function () { return figma.loadAllPagesAsync(); });
      var after = mutateFile("verify pages after loading", function () { return figma.root.children; });
      if (!Array.isArray(after) || after.length !== before.length || !after.length) {
        throw new Error("loadAllPagesAsync did not preserve the document's page inventory.");
      }
    });
    await runTest("Image API", "figma.createImage", async function () {
      if (!pngExportBytes || !pngExportBytes.length) throw new Error("PNG export fixture bytes are missing.");
      var image = mutateFile("create image resource from PNG export", function () { return figma.createImage(pngExportBytes); });
      if (!image || typeof image.hash !== "string" || !image.hash) throw new Error("createImage did not return an image hash.");
      var bytes = await mutateFileAsync("read created image bytes", function () { return image.getBytesAsync(); });
      if (!bytes || !bytes.length) throw new Error("Created image resource did not return bytes.");
    });
    await runTest("Slice API", "figma.createSlice", async function () {
      var sliceName = "__UXD API HEALTH SLICE";
      var node = findNodeByName(testPage, sliceName, "SLICE");
      if (!node) {
        // createSlice is initially attached to currentPage; move it synchronously
        // into the approved inactive Test Lab page before yielding to the editor.
        node = mutateFile("create isolated slice probe", function () { return figma.createSlice(); });
        mutateFile("move slice into isolated Test Lab page", function () { testPage.appendChild(node); });
        mutateFile("name isolated slice probe", function () { node.name = sliceName; });
      }
      mutateFile("size isolated slice probe", function () { node.resize(24, 24); });
      if (node.type !== "SLICE" || node.parent !== testPage || node.width !== 24 || node.height !== 24) {
        throw new Error("createSlice did not produce a reusable slice inside the Test Lab page.");
      }
    });
    await runTest("Undo API", "figma.triggerUndo", async function () {
      if (typeof figma.commitUndo !== "function" || typeof figma.triggerUndo !== "function") {
        throw new Error("Undo checkpoint APIs are unavailable.");
      }
      var nodeName = "__UXD UNDO PROBE " + Date.now();
      mutateFile("commit undo probe baseline", function () { figma.commitUndo(); });
      var probe = mutateFile("create undo probe node", function () { return figma.createRectangle(); });
      mutateLab("attach undo probe to isolated Test Lab", function () { harness.appendChild(probe); });
      mutateLab("name undo probe node", function () { probe.name = nodeName; });
      mutateFile("trigger undo for isolated probe", function () { figma.triggerUndo(); });
      assertLab("verify undo probe was reverted");
      if (findNodeByName(harness, nodeName, "RECTANGLE")) {
        throw new Error("triggerUndo did not revert the isolated probe created after the undo checkpoint.");
      }
    });
    await runTest("Plugin UI", "figma.ui.resize", async function () {
      if (typeof figma.ui.resize !== "function") throw new Error("Plugin UI resize API is unavailable.");
      // Match the dimensions passed to showUI so the health check has no visible resize side effect.
      mutateFile("verify plugin UI dimensions", function () { figma.ui.resize(380, 720); });
    });
    availability("Plugin UI", "figma.ui.on", typeof figma.ui.on === "function",
      "Availability only; intentionally not invoked.");
    availability("Plugin UI", "figma.ui.off", typeof figma.ui.off === "function",
      "Availability only; intentionally not invoked.");
    await runTest("Variables", "figma.variables.getVariableCollectionByIdAsync", async function () {
      if (!figma.variables || typeof figma.variables.getVariableCollectionByIdAsync !== "function") {
        throw new Error("Variable collection ID lookup API is unavailable.");
      }
      var collectionId = healthVariableCollectionId;
      if (!collectionId) {
        var collections = await mutateLabAsync("find persistent health variable collection", function () { return figma.variables.getLocalVariableCollectionsAsync(); });
        var existing = collections.find(function (item) { return item.name === "__UXD API HEALTH VARIABLES"; }) || null;
        if (!existing) throw new Error("Persistent health variable collection fixture was not found.");
        collectionId = existing.id;
      }
      var collection = await mutateFileAsync("resolve variable collection by ID", function () {
        return figma.variables.getVariableCollectionByIdAsync(collectionId);
      });
      if (!collection || collection.id !== collectionId) {
        throw new Error("getVariableCollectionByIdAsync did not resolve the persistent test collection.");
      }
    });
    add("Library", "Team Library", "not-tested", "not-tested",
      "Not tested intentionally: team-library APIs are out of scope; no teamlibrary permission, shared-library lookup, or import is enabled.");
  } catch (error) {
    add("Test runner", "Unexpected health-check failure", "functional", "error", error && error.message ? error.message : String(error));
  } finally {
    // No test fixtures are deleted. Only restore the plugin's selection telemetry
    // listener; the user's active page is never changed by the test suite.
    if (selectionHandlerPaused) {
      try {
        assertUxDirectFileScope("restore selection context listener");
        figma.on("selectionchange", sendSelection);
      } catch (error) {
        add("Test cleanup", "Restore selection context listener", "functional", "error",
          error && error.message ? error.message : String(error));
      }
    }
    cleanupProgress("Persistent Test Lab retained; no cleanup or page navigation performed.");
  }
  await postResult();
}
async function runNativeApiHealthCheck(commandId) {
  assertUxDirectFileScope("request health check");
  if (commandId && UXD_HEALTH_CHECK_PENDING_COMMAND_IDS.indexOf(commandId) === -1) UXD_HEALTH_CHECK_PENDING_COMMAND_IDS.push(commandId);
  if (UXD_HEALTH_CHECK_RUNNING) {
    figma.ui.postMessage({ type: "native-health-progress", text: "A health check is already running; this request will receive that run's result." });
    return;
  }
  UXD_HEALTH_CHECK_RUNNING = true;
  try {
    await executeNativeApiHealthCheck();
  } finally {
    UXD_HEALTH_CHECK_RUNNING = false;
    // Cover a command that arrived at the exact boundary after the report was sent.
    if (UXD_HEALTH_CHECK_PENDING_COMMAND_IDS.length && UXD_HEALTH_CHECK_LAST_REPORT) {
      var lateIds = UXD_HEALTH_CHECK_PENDING_COMMAND_IDS.splice(0);
      lateIds.forEach(function (id) {
        figma.ui.postMessage(Object.assign({}, UXD_HEALTH_CHECK_LAST_REPORT, { commandId: id }));
      });
    }
  }
}
figma.ui.onmessage = async function (message) {
  if (!message) return;
  if (message.type === "native-api-probe-ack" && message.probeId && UXD_NATIVE_API_PROBE_WAITERS[message.probeId]) {
    var resolveProbe = UXD_NATIVE_API_PROBE_WAITERS[message.probeId];
    delete UXD_NATIVE_API_PROBE_WAITERS[message.probeId];
    resolveProbe();
    return;
  }
  if (message.type === "get-selection") { assertUxDirectFileScope("refresh selection"); sendSelection(); }
  if (message.type === "apply-design-operations") {
    try { await executeDesignOperations(message.payload); }
    catch (error) {
      figma.ui.postMessage({ type: "design-operation-result", ok: false, error: error && error.message ? error.message : String(error) });
    }
    return;
  }
  if (message.type === "run-native-health-check") { assertUxDirectFileScope("start health-check command"); await runNativeApiHealthCheck(message.commandId); }
  if (message.type === "close") { assertUxDirectFileScope("close plugin"); figma.closePlugin(); }
};
sendSelection();

}
var uxdScopeDecision = getUxDirectScopeDecision();
if (uxdScopeDecision.allowed) {
  startScopedPlugin();
} else {
  figma.closePlugin("UX Direct blocked: " + uxdScopeDecision.reason + " Only the approved Zunaid_Workspace file is allowed.");
}

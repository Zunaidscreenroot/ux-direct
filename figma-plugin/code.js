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
function getSelectionSummary() {
  assertUxDirectFileScope("reading selection metadata");
  return figma.currentPage.selection.map(function (node) {
    return { id: node.id, name: node.name, type: node.type, visible: node.visible,
      childCount: "children" in node ? node.children.length : undefined };
  });
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
    checks.push({ category: String(category || "General").slice(0, 80), name: String(name || "Unnamed check").slice(0, 120),
      level: level, status: status,
      reason: String(reason || (status === "success" ? "Executed and verified" : "Operation failed")).slice(0, 400) });
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
    // Build a broad, non-destructive capability catalogue for the in-Figma health panel.
    // These probes only inspect supported API surface. They never access external folders/files.
    var implementedCanvasActions = [
      "batch", "create-elements", "create-tree", "update-node", "clone-node", "delete-node", "reorder-node",
      "reparent-node", "group-nodes", "ungroup-node", "flatten-nodes", "boolean-operation",
      "create-component", "create-component-set", "create-instance", "swap-component", "detach-instance",
      "set-selection", "zoom-to-nodes", "create-page", "rename-page", "set-current-page",
      "export-svg", "export-node", "apply-style", "set-text-range", "create-image-fill",
      "insert-image", "create-variables", "bind-variable", "wrap-in-auto-layout", "set-fills", "set-effects",
      "set-layout-grids", "add-component-property", "set-instance-properties", "set-reactions", "set-flow-start",
      "create-styles", "set-variable-mode"
    ];
    var writerSource = String(writeCanvasCommand);
    implementedCanvasActions.forEach(function (operation) {
      var implemented = writerSource.indexOf('payload.operation === "' + operation + '"') >= 0;
      if (operation === "batch") implemented = writerSource.indexOf('payload.operation === "batch"') >= 0;
      availability("Canvas writer", "UX Direct action · " + operation, implemented,
        implemented
          ? "The scoped native-command executor contains this validated operation. Capability check only; see functional checks for APIs exercised end to end."
          : "No native-command handler for this action was detected.");
    });
    availability("Canvas reader", "Read selected node tree", typeof readCanvasCommand === "function",
      "Bounded selection-tree reader is implemented and limited to the approved current document.");
    availability("Canvas reader", "Search current-page layers by name/type", String(readCanvasCommand).indexOf("search-current-page") >= 0,
      "Search API capability inspection only.");
    availability("Canvas writer", "Validated write confirmation guard", String(writeCanvasCommand).indexOf("payload.confirm !== true") >= 0,
      "Native writes require an explicit confirm flag.");
    availability("Canvas writer", "Write target scope guard", String(resolveCanvasWriteParent).indexOf("resolveCanvasWriteParent") >= 0,
      "Writes resolve only to current-page, single selected container, or the isolated UXD Test Lab target.");
    
    function findHealthNode(type) {
      try {
        if (!testPage || typeof testPage.findAll !== "function") return null;
        return testPage.findAll(function (node) { return node && node.type === type; })[0] || null;
      } catch (_) { return null; }
    }
    function probeCapability(category, name, probe, detail) {
      var available = false;
      try { available = !!probe(); } catch (_) { available = false; }
      availability(category, name, available, detail || (available
        ? "Figma Plugin API is exposed in this runtime; availability check only."
        : "Figma Plugin API is not exposed in this runtime."));
    }
    var nativeCapabilityProbes = [
      ["Shapes", "Create FRAME", function () { return typeof figma.createFrame === "function"; }],
      ["Shapes", "Create RECTANGLE", function () { return typeof figma.createRectangle === "function"; }],
      ["Shapes", "Create ELLIPSE", function () { return typeof figma.createEllipse === "function"; }],
      ["Shapes", "Create TEXT", function () { return typeof figma.createText === "function"; }],
      ["Shapes", "Create LINE", function () { return typeof figma.createLine === "function"; }],
      ["Shapes", "Create POLYGON", function () { return typeof figma.createPolygon === "function"; }],
      ["Shapes", "Create STAR", function () { return typeof figma.createStar === "function"; }],
      ["Shapes", "Create VECTOR", function () { return typeof figma.createVector === "function"; }],
      ["Shapes", "Create SLICE", function () { return typeof figma.createSlice === "function"; }],
      ["Shapes", "Create COMPONENT", function () { return typeof figma.createComponent === "function"; }],
      ["Shapes", "Create component from node", function () { return typeof figma.createComponentFromNode === "function"; }],
      ["Shapes", "Create IMAGE", function () { return typeof figma.createImage === "function"; }],
      ["Shapes", "Create PAGE", function () { return typeof figma.createPage === "function"; }],
      ["Geometry", "Union boolean operation", function () { return typeof figma.union === "function"; }],
      ["Geometry", "Subtract boolean operation", function () { return typeof figma.subtract === "function"; }],
      ["Geometry", "Intersect boolean operation", function () { return typeof figma.intersect === "function"; }],
      ["Geometry", "Exclude boolean operation", function () { return typeof figma.exclude === "function"; }],
      ["Geometry", "Group nodes", function () { return typeof figma.group === "function"; }],
      ["Geometry", "Ungroup nodes", function () { return typeof figma.ungroup === "function"; }],
      ["Components", "Combine as variants", function () { return typeof figma.combineAsVariants === "function"; }],
      ["Node inspection", "Resolve node by async ID", function () { return typeof figma.getNodeByIdAsync === "function"; }],
      ["Node inspection", "Find one current-page node", function () { return typeof figma.currentPage.findOne === "function"; }],
      ["Node inspection", "Find all current-page nodes", function () { return typeof figma.currentPage.findAll === "function"; }],
      ["Node inspection", "Find nodes by criteria", function () { return typeof figma.currentPage.findAllWithCriteria === "function"; }],
      ["Node inspection", "Read page children", function () { return Array.isArray(figma.currentPage.children); }],
      ["Node inspection", "Read current page selection", function () { return Array.isArray(figma.currentPage.selection); }],
      ["Node inspection", "Read current page name", function () { return typeof figma.currentPage.name === "string"; }],
      ["Node inspection", "Find node by ID in selected page", function () { return typeof figma.currentPage.findOne === "function"; }],
      ["Node actions", "Clone node API", function () { return typeof figma.currentPage.clone === "function" || !!(harness && typeof harness.clone === "function"); }],
      ["Node actions", "Remove node API", function () { return !!(harness && typeof harness.remove === "function"); }],
      ["Node actions", "Insert child API", function () { return typeof figma.currentPage.insertChild === "function"; }],
      ["Node actions", "Append child API", function () { return typeof figma.currentPage.appendChild === "function"; }],
      ["Node actions", "Set plugin data", function () { return !!(harness && typeof harness.setPluginData === "function"); }],
      ["Node actions", "Get plugin data", function () { return !!(harness && typeof harness.getPluginData === "function"); }],
      ["Node actions", "Set shared plugin data", function () { return !!(harness && typeof harness.setSharedPluginData === "function"); }],
      ["Node actions", "Get shared plugin data", function () { return !!(harness && typeof harness.getSharedPluginData === "function"); }],
      ["Layout", "Resize node API", function () { return !!(harness && typeof harness.resize === "function"); }],
      ["Layout", "Resize with constraints API", function () { return !!(harness && typeof harness.resizeWithoutConstraints === "function"); }],
      ["Layout", "Relative transform property", function () { return !!(harness && "relativeTransform" in harness); }],
      ["Layout", "Absolute transform property", function () { return !!(harness && "absoluteTransform" in harness); }],
      ["Layout", "Absolute bounding box property", function () { return !!(harness && "absoluteBoundingBox" in harness); }],
      ["Layout", "Constraints property", function () { return !!(harness && "constraints" in harness); }],
      ["Layout", "Rotation property", function () { return !!(harness && "rotation" in harness); }],
      ["Layout", "Opacity property", function () { return !!(harness && "opacity" in harness); }],
      ["Layout", "Visible property", function () { return !!(harness && "visible" in harness); }],
      ["Layout", "Locked property", function () { return !!(harness && "locked" in harness); }],
      ["Layout", "Clips content property", function () { return !!(harness && "clipsContent" in harness); }],
      ["Layout", "Corner radius property", function () { return !!(harness && "cornerRadius" in harness); }],
      ["Layout", "Corner smoothing property", function () { return !!(harness && "cornerSmoothing" in harness); }],
      ["Layout", "Auto layout mode property", function () { return !!(harness && "layoutMode" in harness); }],
      ["Layout", "Auto layout item spacing", function () { return !!(harness && "itemSpacing" in harness); }],
      ["Layout", "Auto layout padding", function () { return !!(harness && "paddingTop" in harness && "paddingBottom" in harness); }],
      ["Layout", "Primary axis alignment", function () { return !!(harness && "primaryAxisAlignItems" in harness); }],
      ["Layout", "Counter axis alignment", function () { return !!(harness && "counterAxisAlignItems" in harness); }],
      ["Layout", "Primary axis sizing mode", function () { return !!(harness && "primaryAxisSizingMode" in harness); }],
      ["Layout", "Counter axis sizing mode", function () { return !!(harness && "counterAxisSizingMode" in harness); }],
      ["Paint", "Fills property", function () { return !!(harness && "fills" in harness); }],
      ["Paint", "Strokes property", function () { return !!(harness && "strokes" in harness); }],
      ["Paint", "Stroke weight property", function () { return !!(harness && "strokeWeight" in harness); }],
      ["Paint", "Stroke alignment property", function () { return !!(harness && "strokeAlign" in harness); }],
      ["Paint", "Effects property", function () { return !!(harness && "effects" in harness); }],
      ["Paint", "Blend mode property", function () { return !!(harness && "blendMode" in harness); }],
      ["Paint", "Export API on node", function () { return !!(harness && typeof harness.exportAsync === "function"); }],
      ["Text", "Load font async", function () { return typeof figma.loadFontAsync === "function"; }],
      ["Text", "Get text styles async", function () { return typeof figma.getLocalTextStylesAsync === "function"; }],
      ["Text", "Create text style", function () { return typeof figma.createTextStyle === "function"; }],
      ["Text", "Text node fontName property", function () { var textNode = testPage && testPage.findAll(function (node) { return node.type === "TEXT"; })[0]; return !!(textNode && "fontName" in textNode); }],
      ["Text", "Font size property", function () { var node = findHealthNode("TEXT"); return !!(node && "fontSize" in node); }],
      ["Text", "Text alignment property", function () { var node = findHealthNode("TEXT"); return !!(node && "textAlignHorizontal" in node); }],
      ["Text", "Text vertical alignment property", function () { var node = findHealthNode("TEXT"); return !!(node && "textAlignVertical" in node); }],
      ["Text", "Text auto resize property", function () { var node = findHealthNode("TEXT"); return !!(node && "textAutoResize" in node); }],
      ["Text", "Text case property", function () { var node = findHealthNode("TEXT"); return !!(node && "textCase" in node); }],
      ["Text", "Text decoration property", function () { var node = findHealthNode("TEXT"); return !!(node && "textDecoration" in node); }],
      ["Text", "Text range API", function () { var node = findHealthNode("TEXT"); return !!(node && typeof node.setRangeFontSize === "function"); }],
      ["Text", "Line height property", function () { var node = findHealthNode("TEXT"); return !!(node && "lineHeight" in node); }],
      ["Text", "Letter spacing property", function () { var node = findHealthNode("TEXT"); return !!(node && "letterSpacing" in node); }],
      ["Text", "List bullet property", function () { var node = findHealthNode("TEXT"); return !!(node && "listSpacing" in node); }],
      ["Text", "Paragraph indent property", function () { var node = findHealthNode("TEXT"); return !!(node && "paragraphIndent" in node); }],
      ["Text", "Paragraph spacing property", function () { var node = findHealthNode("TEXT"); return !!(node && "paragraphSpacing" in node); }],
      ["Components", "Create instance from component", function () { var component = findHealthNode("COMPONENT"); return !!(component && typeof component.createInstance === "function"); }],
      ["Components", "Instance detach API", function () { var instance = testPage && testPage.findAll(function (node) { return node.type === "INSTANCE"; })[0]; return !!(instance && typeof instance.detachInstance === "function"); }],
      ["Components", "Instance main component lookup", function () { var instance = testPage && testPage.findAll(function (node) { return node.type === "INSTANCE"; })[0]; return !!(instance && typeof instance.getMainComponentAsync === "function"); }],
      ["Components", "Component property definitions", function () { var component = findHealthNode("COMPONENT_SET") || findHealthNode("COMPONENT"); return !!(component && "componentPropertyDefinitions" in component); }],
      ["Components", "Component properties", function () { var instance = findHealthNode("INSTANCE"); return !!(instance && "componentProperties" in instance); }],
      ["Components", "Expose component properties", function () { var component = findHealthNode("COMPONENT"); return !!(component && typeof component.addComponentProperty === "function"); }],
      ["Components", "Edit component property value", function () { var instance = findHealthNode("INSTANCE"); return !!(instance && typeof instance.setProperties === "function"); }],
      ["Components", "Swap component on instance", function () { var instance = findHealthNode("INSTANCE"); return !!(instance && typeof instance.swapComponent === "function"); }],
      ["Components", "Find component node types", function () { return typeof figma.currentPage.findAllWithCriteria === "function"; }],
      ["Pages", "Create page API", function () { return typeof figma.createPage === "function"; }],
      ["Pages", "Set current page async", function () { return typeof figma.setCurrentPageAsync === "function"; }],
      ["Pages", "Current page append child", function () { return typeof figma.currentPage.appendChild === "function"; }],
      ["Pages", "Current page insert child", function () { return typeof figma.currentPage.insertChild === "function"; }],
      ["Pages", "Current page selection setter", function () { return !!(figma.currentPage && "selection" in figma.currentPage); }],
      ["Viewport", "Viewport bounds", function () { return !!(figma.viewport && figma.viewport.bounds); }],
      ["Viewport", "Viewport zoom", function () { return typeof figma.viewport.zoom === "number"; }],
      ["Viewport", "Scroll and zoom into view", function () { return typeof figma.viewport.scrollAndZoomIntoView === "function"; }],
      ["Viewport", "Set viewport API", function () { return typeof figma.viewport.set === "function"; }],
      ["Events", "Register event listener", function () { return typeof figma.on === "function"; }],
      ["Events", "Remove event listener", function () { return typeof figma.off === "function"; }],
      ["Events", "Listen from UI", function () { return typeof figma.ui.on === "function"; }],
      ["Events", "Stop UI listener", function () { return typeof figma.ui.off === "function"; }],
      ["Events", "Post message to UI", function () { return typeof figma.ui.postMessage === "function"; }],
      ["Plugin UI", "Show plugin UI", function () { return typeof figma.showUI === "function"; }],
      ["Plugin UI", "Resize plugin UI", function () { return typeof figma.ui.resize === "function"; }],
      ["Plugin UI", "UI close API", function () { return typeof figma.closePlugin === "function"; }],
      ["Plugin UI", "Notification API", function () { return typeof figma.notify === "function"; }],
      ["Styles", "Get local paint styles", function () { return typeof figma.getLocalPaintStylesAsync === "function"; }],
      ["Styles", "Get local text styles", function () { return typeof figma.getLocalTextStylesAsync === "function"; }],
      ["Styles", "Get local effect styles", function () { return typeof figma.getLocalEffectStylesAsync === "function"; }],
      ["Styles", "Get local grid styles", function () { return typeof figma.getLocalGridStylesAsync === "function"; }],
      ["Styles", "Get style by ID async", function () { return typeof figma.getStyleByIdAsync === "function"; }],
      ["Styles", "Create paint style", function () { return typeof figma.createPaintStyle === "function"; }],
      ["Styles", "Create text style", function () { return typeof figma.createTextStyle === "function"; }],
      ["Styles", "Create effect style", function () { return typeof figma.createEffectStyle === "function"; }],
      ["Styles", "Create grid style", function () { return typeof figma.createGridStyle === "function"; }],
      ["Styles", "Create color variable collection", function () { return !!(figma.variables && typeof figma.variables.createVariableCollection === "function"); }],
      ["Styles", "Create local variable", function () { return !!(figma.variables && typeof figma.variables.createVariable === "function"); }],
      ["Variables", "Get local variables async", function () { return !!(figma.variables && typeof figma.variables.getLocalVariablesAsync === "function"); }],
      ["Variables", "Get local collections async", function () { return !!(figma.variables && typeof figma.variables.getLocalVariableCollectionsAsync === "function"); }],
      ["Variables", "Get variable by ID async", function () { return !!(figma.variables && typeof figma.variables.getVariableByIdAsync === "function"); }],
      ["Variables", "Get collection by ID async", function () { return !!(figma.variables && typeof figma.variables.getVariableCollectionByIdAsync === "function"); }],
      ["Variables", "Variable mode values", function () { return !!(figma.variables && typeof figma.variables.setBoundVariableForPaint === "function"); }],
      ["Variables", "Bind variable to node property", function () { return !!(figma.variables && typeof figma.variables.setBoundVariableForPaint === "function"); }],
      ["Variables", "Create alias variable", function () { return !!(figma.variables && typeof figma.variables.createVariableAlias === "function"); }],
      ["Variables", "Variable remove API", function () { return !!(figma.variables && typeof figma.variables.deleteVariable === "function"); }],
      ["Storage", "Read client storage", function () { return !!(figma.clientStorage && typeof figma.clientStorage.getAsync === "function"); }],
      ["Storage", "Write client storage", function () { return !!(figma.clientStorage && typeof figma.clientStorage.setAsync === "function"); }],
      ["Storage", "Delete client storage key", function () { return !!(figma.clientStorage && typeof figma.clientStorage.deleteAsync === "function"); }],
      ["Image API", "Create image from bytes", function () { return typeof figma.createImage === "function"; }],
      ["Image API", "Create image paint", function () { return !!(harness && "fills" in harness); }],
      ["Image API", "Image hash on image object", function () { return typeof figma.createImage === "function"; }],
      ["Export", "Export PNG format", function () { return !!(harness && typeof harness.exportAsync === "function"); }],
      ["Export", "Export PDF format", function () { return !!(harness && typeof harness.exportAsync === "function"); }],
      ["Export", "Export SVG string", function () { return !!(harness && typeof harness.exportAsync === "function"); }],
      ["Plugin context", "Current page node tree", function () { return !!(figma.currentPage && typeof figma.currentPage.findAll === "function"); }],
      ["Plugin context", "Selection change subscription", function () { return typeof figma.on === "function" && typeof figma.off === "function"; }],
      ["Plugin context", "Viewport navigation", function () { return !!(figma.viewport && typeof figma.viewport.scrollAndZoomIntoView === "function"); }],
      ["Plugin context", "Plugin command messaging", function () { return typeof figma.ui.postMessage === "function" && typeof figma.ui.on === "function"; }]
    ];
    nativeCapabilityProbes.forEach(function (probe) {
      probeCapability(probe[0], probe[1], probe[2], "Native Figma API surface checked without reading or writing external folders/files.");
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
function canvasColorHex(color) {
  if (!color || typeof color.r !== "number" || typeof color.g !== "number" || typeof color.b !== "number") return null;
  function ch(n) { return Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, "0"); }
  return "#" + ch(color.r) + ch(color.g) + ch(color.b).toUpperCase();
}
function summarizePaintColors(paints) {
  if (!Array.isArray(paints)) return [];
  // Gradient fills (e.g. a gradient CTA) report their first stop so the layer still reads as filled.
  return paints.filter(function (paint) {
    return paint && paint.visible !== false && ((paint.type === "SOLID" && paint.color) ||
      (/^GRADIENT_/.test(String(paint.type)) && Array.isArray(paint.gradientStops) && paint.gradientStops.length && paint.gradientStops[0].color));
  }).slice(0, 3).map(function (paint) { return canvasColorHex(paint.type === "SOLID" ? paint.color : paint.gradientStops[0].color); }).filter(Boolean);
}
function summarizeCanvasNode(node, depth, state) {
  if (!node || state.count >= state.maxNodes) { state.truncated = true; return null; }
  state.count += 1;
  var out = { id: node.id, name: node.name, type: node.type };
  if (typeof node.visible === "boolean") out.visible = node.visible;
  if (typeof node.x === "number") out.x = node.x;
  if (typeof node.y === "number") out.y = node.y;
  if (typeof node.width === "number") out.width = node.width;
  if (typeof node.height === "number") out.height = node.height;
  if (typeof node.rotation === "number") out.rotation = node.rotation;
  if (typeof node.opacity === "number") out.opacity = node.opacity;
  if (typeof node.strokeWeight === "number") out.strokeWeight = node.strokeWeight;
  if (typeof node.cornerRadius === "number") out.cornerRadius = node.cornerRadius;
  if (typeof node.clipsContent === "boolean") out.clipsContent = node.clipsContent;
  if ("fills" in node) {
    var fills = summarizePaintColors(node.fills);
    if (fills.length) out.fillColors = fills;
  }
  if ("strokes" in node) {
    var strokes = summarizePaintColors(node.strokes);
    if (strokes.length) out.strokeColors = strokes;
  }
  ["layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning", "layoutWrap",
    "horizontalConstraint", "verticalConstraint", "primaryAxisSizingMode", "counterAxisSizingMode",
    "primaryAxisAlignItems", "counterAxisAlignItems", "textAutoResize"].forEach(function (key) {
    try { if (node[key] !== undefined && node[key] !== figma.mixed) out[key] = node[key]; } catch (_) {}
  });
  ["layoutGrow", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom"].forEach(function (key) {
    try { if (typeof node[key] === "number" && Number.isFinite(node[key])) out[key] = node[key]; } catch (_) {}
  });
  if (typeof node.layoutMode === "string" && node.layoutMode !== "NONE") {
    out.layoutMode = node.layoutMode;
  }
  if (node.type === "INSTANCE") {
    try {
      var instanceProps = node.componentProperties || {};
      var compactProps = {};
      Object.keys(instanceProps).slice(0, 20).forEach(function (key) {
        var value = instanceProps[key] && instanceProps[key].value;
        compactProps[key.split("#")[0]] = typeof value === "string" ? value.slice(0, 120) : value;
      });
      if (Object.keys(compactProps).length) out.componentProperties = compactProps;
    } catch (_) {}
  }
  // Design-system usage flags for hygiene checks (style/variable bound vs hard-coded).
  try { if (typeof node.fillStyleId === "string" && node.fillStyleId) out.fillStyled = true; } catch (_) {}
  try { if (typeof node.textStyleId === "string" && node.textStyleId) out.textStyled = true; } catch (_) {}
  try { if (node.boundVariables && Object.keys(node.boundVariables).length) out.variableBound = true; } catch (_) {}
  try {
    if ("fills" in node && Array.isArray(node.fills) &&
        node.fills.some(function (paint) { return paint && paint.type === "IMAGE" && paint.visible !== false; })) out.imageFill = true;
  } catch (_) {}
  if ("effects" in node && Array.isArray(node.effects) && node.effects.length) {
    out.effectTypes = node.effects.slice(0, 4).map(function (effect) { return effect.type; });
  }
  if (node.type === "INSTANCE" && Array.isArray(state.instances) && state.instances.length < 40) state.instances.push([node, out]);
  if (node.type === "TEXT" && typeof node.characters === "string") {
    // Source text styles (often library styles) let generated variations reuse the design system.
    try { if (typeof node.textStyleId === "string" && node.textStyleId) out.textStyleId = node.textStyleId; } catch (_) {}
    out.text = node.characters.slice(0, 700);
    out.textTruncated = node.characters.length > 700;
    if (typeof node.fontSize === "number") out.fontSize = node.fontSize;
    if (node.fontName && typeof node.fontName === "object" && node.fontName !== figma.mixed) {
      if (typeof node.fontName.family === "string") out.fontFamily = node.fontName.family;
      if (typeof node.fontName.style === "string") out.fontStyle = node.fontName.style;
    }
    ["textAlignHorizontal", "textAlignVertical", "textAutoResize", "textCase", "textDecoration"].forEach(function (key) {
      if (node[key] !== undefined && node[key] !== figma.mixed) out[key] = node[key];
    });
  }
  if ("children" in node) {
    out.childCount = node.children.length;
    // Instance internals belong to the component; collapsed reads count them without expanding.
    if (depth > 0 && !(state.collapseInstances && node.type === "INSTANCE")) {
      out.children = [];
      for (var i = 0; i < node.children.length; i++) {
        if (state.count >= state.maxNodes) { state.truncated = true; break; }
        var child = summarizeCanvasNode(node.children[i], depth - 1, state);
        if (child) out.children.push(child);
      }
    }
  }
  return out;
}
async function readCanvasCommand(payload) {
  assertUxDirectFileScope("read canvas");
  payload = payload || {};
  var scope = payload.scope === "current-page" ? "current-page" : "selection";
  var maxDepth = Math.max(0, Math.min(12, Number.isInteger(payload.maxDepth) ? payload.maxDepth : 2));
  var maxNodes = Math.max(1, Math.min(500, Number.isInteger(payload.maxNodes) ? payload.maxNodes : 60));
  var isSearch = (typeof payload.queryName === "string" && payload.queryName.trim()) ||
    (typeof payload.queryType === "string" && payload.queryType.trim());
  var source;
  if (isSearch) {
    var nameNeedle = typeof payload.queryName === "string" ? payload.queryName.trim().toLowerCase() : "";
    var typeNeedle = typeof payload.queryType === "string" ? payload.queryType.trim().toUpperCase() : "";
    source = figma.currentPage.findAll(function (node) {
      if (!node || node.type === "PAGE" || node.type === "DOCUMENT") return false;
      if (nameNeedle && String(node.name || "").toLowerCase().indexOf(nameNeedle) < 0) return false;
      if (typeNeedle && String(node.type || "").toUpperCase() !== typeNeedle) return false;
      return true;
    });
    scope = "search-current-page";
  } else if (Array.isArray(payload.nodeIds) && payload.nodeIds.length) {
    // Read named nodes without touching the selection, so parallel variation jobs don't race.
    source = [];
    for (var ni = 0; ni < payload.nodeIds.length && ni < 20; ni++) {
      var byId = typeof payload.nodeIds[ni] === "string" ? await figma.getNodeByIdAsync(payload.nodeIds[ni]) : null;
      if (byId && byId.type !== "PAGE" && byId.type !== "DOCUMENT") source.push(byId);
    }
    scope = "selection";
  } else {
    source = scope === "current-page" ? figma.currentPage.children : figma.currentPage.selection;
  }
  var state = { count: 0, maxNodes: maxNodes, truncated: false, collapseInstances: payload.collapseInstances === true, instances: [] };
  var nodes = [];
  for (var i = 0; i < source.length; i++) {
    if (state.count >= state.maxNodes) { state.truncated = true; break; }
    var item = summarizeCanvasNode(source[i], isSearch ? 0 : maxDepth, state);
    if (item) nodes.push(item);
  }
  // dynamic-page access forbids the sync mainComponent getter; resolve instance sources async.
  for (var k = 0; k < state.instances.length; k++) {
    try {
      var main = await state.instances[k][0].getMainComponentAsync();
      if (main) {
        var owner = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : main;
        state.instances[k][1].mainComponentId = owner.id;
        state.instances[k][1].mainComponentName = String(owner.name).slice(0, 120);
      }
    } catch (_) {}
  }
  var result = {
    ok: true, operation: "read-canvas", fileKey: figma.fileKey,
    pageId: figma.currentPage.id, pageName: figma.currentPage.name,
    scope: scope, maxDepth: isSearch ? 0 : maxDepth, maxNodes: maxNodes,
    nodeCount: state.count, truncated: state.truncated, nodes: nodes,
    viewport: { zoom: figma.viewport.zoom, bounds: figma.viewport.bounds }
  };
  if (payload.includePages === true) {
    result.pages = figma.root.children.slice(0, 100).map(function (page) { return { id: page.id, name: page.name }; });
    result.pagesTruncated = figma.root.children.length > 100;
  }
  if (payload.includeStyles === true) {
    // The page's dominant screen fill (by area of top-level frames), so a new screen matches the file's theme.
    try {
      var fillArea = {};
      figma.currentPage.children.slice(0, 200).forEach(function (top) {
        if (top.type !== "FRAME" && top.type !== "COMPONENT" && top.type !== "INSTANCE") return;
        var fills = Array.isArray(top.fills) ? top.fills : [];
        var solid = fills.filter(function (f) { return f && f.visible !== false && f.type === "SOLID" && (f.opacity === undefined || f.opacity >= 0.99); })[0];
        if (!solid || top.width < 240 || top.height < 400) return;
        var hexValue = canvasColorHex(solid.color);
        fillArea[hexValue] = (fillArea[hexValue] || 0) + top.width * top.height;
      });
      var bestFill = Object.keys(fillArea).sort(function (a, b) { return fillArea[b] - fillArea[a]; })[0];
      if (bestFill) result.pageBackground = bestFill;
    } catch (_) {}
    var styles = await Promise.all([
      figma.getLocalPaintStylesAsync(),
      figma.getLocalTextStylesAsync(),
      figma.getLocalEffectStylesAsync(),
      figma.getLocalGridStylesAsync()
    ]);
    result.styles = {
      // Colour and type metrics let the renderer bind generated layers to matching file styles.
      paint: styles[0].slice(0, 100).map(function (style) {
        var out = { id: style.id, name: style.name };
        var solid = Array.isArray(style.paints) && style.paints.length === 1 && style.paints[0].type === "SOLID" ? style.paints[0] : null;
        if (solid && solid.color && (solid.opacity === undefined || solid.opacity >= 0.99)) out.color = canvasColorHex(solid.color);
        return out;
      }),
      text: styles[1].slice(0, 100).map(function (style) {
        var out = { id: style.id, name: style.name };
        if (typeof style.fontSize === "number") out.fontSize = style.fontSize;
        if (style.fontName && typeof style.fontName.family === "string") { out.fontFamily = style.fontName.family; out.fontStyle = style.fontName.style; }
        return out;
      }),
      effect: styles[2].slice(0, 50).map(function (style) { return { id: style.id, name: style.name }; }),
      grid: styles[3].slice(0, 50).map(function (style) { return { id: style.id, name: style.name }; })
    };
  }
  if (payload.includeComponents === true) {
    result.components = await cachedComponentCatalogue();
  }
  if (payload.includeVariables === true && figma.variables &&
      typeof figma.variables.getLocalVariablesAsync === "function" &&
      typeof figma.variables.getLocalVariableCollectionsAsync === "function") {
    var variableData = await Promise.all([
      figma.variables.getLocalVariablesAsync(),
      figma.variables.getLocalVariableCollectionsAsync()
    ]);
    var collections = variableData[1] || [];
    var collectionById = new Map(collections.map(function (collection) { return [collection.id, collection]; }));
    result.variableCollections = collections.slice(0, 30).map(function (collection) {
      return { id: collection.id, name: collection.name,
        modes: (collection.modes || []).slice(0, 8).map(function (mode) { return { modeId: mode.modeId, name: mode.name }; }) };
    });
    result.variables = (variableData[0] || []).slice(0, 120).map(function (variable) {
      var collection = collectionById.get(variable.variableCollectionId);
      return { id: variable.id, name: variable.name, type: variable.resolvedType,
        collectionId: variable.variableCollectionId, collectionName: collection ? collection.name : "",
        scopes: Array.isArray(variable.scopes) ? variable.scopes.slice(0, 12) : [] };
    });
  }
  return result;
}
function summarizeComponentDefinitions(component) {
  var definitions = {};
  try {
    var raw = component.componentPropertyDefinitions || {};
    Object.keys(raw).slice(0, 12).forEach(function (key) {
      var def = raw[key];
      var entry = { type: def.type };
      if (def.type === "VARIANT" && Array.isArray(def.variantOptions)) entry.options = def.variantOptions.slice(0, 12).map(function (o) { return String(o).slice(0, 40); });
      else if (def.defaultValue !== undefined) entry.defaultValue = typeof def.defaultValue === "string" ? def.defaultValue.slice(0, 60) : def.defaultValue;
      definitions[key.split("#")[0]] = entry;
    });
  } catch (_) {}
  return definitions;
}
// Bounded catalogue of components the AI may instantiate: components used by instances on this
// page (ranked by use, includes library components) plus local components and sets in the file.
var COMPONENT_CATALOGUE_BUDGET_MS = 8000;
var COMPONENT_CATALOGUE_MAX_CHARS = 18000;
// The catalogue scan can take seconds on large files (page loads + main-component lookups) and
// barely changes within a session, so repeat reads reuse it for a few minutes.
var COMPONENT_CATALOGUE_CACHE_MS = 5 * 60 * 1000;
var componentCatalogueCache = null;
function cachedComponentCatalogue() {
  var now = Date.now();
  if (componentCatalogueCache && componentCatalogueCache.pageId === figma.currentPage.id &&
      now - componentCatalogueCache.at < COMPONENT_CATALOGUE_CACHE_MS) return componentCatalogueCache.promise;
  var promise = collectComponentCatalogue();
  componentCatalogueCache = { at: now, pageId: figma.currentPage.id, promise: promise };
  promise.catch(function () { componentCatalogueCache = null; });
  return promise;
}
async function collectComponentCatalogue() {
  var byId = new Map();
  function record(component, uses, source) {
    if (!component) return;
    var owner = component.parent && component.parent.type === "COMPONENT_SET" ? component.parent : component;
    var existing = byId.get(owner.id);
    if (existing) { existing.uses += uses; return; }
    var item = { id: owner.id, name: String(owner.name).slice(0, 120), type: owner.type, uses: uses, source: source,
      width: Math.round(component.width), height: Math.round(component.height), properties: summarizeComponentDefinitions(owner) };
    if (owner.remote === true) item.remote = true;
    if (owner.type === "COMPONENT_SET" && owner.defaultVariant) item.defaultVariantId = owner.defaultVariant.id;
    var page = owner; while (page && page.type !== "PAGE") page = page.parent;
    if (page) item.pageName = page.name;
    byId.set(owner.id, item);
  }
  // Hard time budget: large client files can have thousands of instances and dozens of
  // unloaded pages, and read-canvas must finish well inside the UI's 90s command timeout.
  var deadline = Date.now() + COMPONENT_CATALOGUE_BUDGET_MS;
  function withinBudget() { return Date.now() < deadline; }
  try {
    var instances = figma.currentPage.findAllWithCriteria({ types: ["INSTANCE"] }).slice(0, 200);
    for (var i = 0; i < instances.length && withinBudget(); i += 25) {
      var batch = instances.slice(i, i + 25).map(function (instance) {
        return instance.getMainComponentAsync().catch(function () { return null; });
      });
      var mains = await Promise.all(batch);
      for (var m = 0; m < mains.length; m++) record(mains[m], 1, "in-use");
    }
  } catch (_) {}
  try {
    // Current page first, then pages that look like component libraries, then the rest,
    // loading other pages only while the budget lasts.
    var pages = figma.root.children.slice().sort(function (a, b) {
      function rank(page) {
        if (page.id === figma.currentPage.id) return 0;
        return /component|design.?system|library|ui.?kit|foundation|atoms|elements/i.test(page.name) ? 1 : 2;
      }
      return rank(a) - rank(b);
    });
    for (var p = 0; p < pages.length && byId.size < 80 && withinBudget(); p++) {
      if (pages[p].id !== figma.currentPage.id) {
        // One huge page can outlast the budget on its own; stop waiting when time runs out.
        var remaining = deadline - Date.now();
        var loaded = await Promise.race([
          pages[p].loadAsync().then(function () { return true; }),
          new Promise(function (resolve) { setTimeout(function () { resolve(false); }, Math.max(0, remaining)); })
        ]);
        if (!loaded) break;
      }
      if (!withinBudget()) break;
      var found = pages[p].findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] });
      for (var c = 0; c < found.length && byId.size < 80; c++) {
        if (found[c].type === "COMPONENT" && found[c].parent && found[c].parent.type === "COMPONENT_SET") continue;
        record(found[c], 0, "local");
      }
    }
  } catch (_) {}
  // The bridge rejects results over 60k chars, so keep the catalogue to a bounded share of that.
  var ranked = Array.from(byId.values()).sort(function (a, b) { return b.uses - a.uses; }).slice(0, 40);
  while (ranked.length > 5 && JSON.stringify(ranked).length > COMPONENT_CATALOGUE_MAX_CHARS) ranked.pop();
  return ranked;
}
function parseHexColor(hex) {
  if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255
  };
}
async function resolveCanvasWriteParent(target, parentNodeId) {
  assertUxDirectFileScope("resolve canvas write target");
  if (target === "current-page" || !target) return figma.currentPage;
  if (target === "selection") {
    var selected = figma.currentPage.selection;
    if (selected.length !== 1 || !("children" in selected[0]) || typeof selected[0].appendChild !== "function") {
      throw new Error("Select exactly one frame or container layer before writing to selection.");
    }
    return selected[0];
  }
  if (target === "node") {
    if (typeof parentNodeId !== "string" || !parentNodeId.trim()) {
      throw new Error("target=node requires parentNodeId.");
    }
    // Direct id lookup instead of a full-page findOne per create (slow on large pages);
    // the ancestor walk keeps writes confined to the current page.
    var parentNode = await figma.getNodeByIdAsync(parentNodeId);
    var onPage = false;
    for (var up = parentNode; up; up = up.parent) { if (up === figma.currentPage) { onPage = true; break; } }
    if (!onPage) parentNode = null;
    if (!parentNode || !("children" in parentNode) || typeof parentNode.appendChild !== "function") {
      throw new Error("parentNodeId must identify a writable container on the current page.");
    }
    return parentNode;
  }
  if (target === "test-lab") {
    await figma.loadAllPagesAsync();
    var page = figma.root.children.find(function (item) { return item.name === UXD_API_TEST_LAB_PAGE; }) || null;
    if (!page) throw new Error("UXD API Test Lab page not found. Run the native Figma API health check first to create it.");
    await page.loadAsync();
    var harnessName = "__UXD CANVAS BRIDGE TESTS";
    var harness = page.children.find(function (item) { return item.type === "FRAME" && item.name === harnessName; }) || null;
    if (!harness) {
      harness = figma.createFrame();
      harness.name = harnessName;
      harness.resize(900, 600);
      harness.fills = [{ type: "SOLID", color: { r: 0.96, g: 0.97, b: 0.99 } }];
      page.appendChild(harness);
    }
    return harness;
  }
  throw new Error("Unsupported write target. Use current-page, selection, or test-lab.");
}
// Commands started by this plugin's own UI never pass through the Worker bridge, so their
// results are not bound by its 60k-char envelope (used for full-resolution screen exports).
var LOCAL_EXPORT_MAX_BYTES = 1100000;
async function writeCanvasCommand(payload, options) {
  var isLocal = !!(options && options.local === true);
  assertUxDirectFileScope("write canvas");
  payload = payload || {};
  if (payload.confirm !== true) throw new Error("Write blocked: confirm must be true after an explicit user request.");
  function nodeSummary(node) {
    var summary = {
      id: node.id, name: node.name, type: node.type, visible: node.visible,
      x: typeof node.x === "number" ? node.x : null,
      y: typeof node.y === "number" ? node.y : null,
      width: typeof node.width === "number" ? node.width : null,
      height: typeof node.height === "number" ? node.height : null,
      rotation: typeof node.rotation === "number" ? node.rotation : null
    };
    ["layoutMode", "layoutWrap", "layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning",
      "primaryAxisSizingMode", "counterAxisSizingMode", "primaryAxisAlignItems", "counterAxisAlignItems",
      "horizontalConstraint", "verticalConstraint", "textAutoResize"].forEach(function (key) {
      try { if (node[key] !== undefined && node[key] !== figma.mixed) summary[key] = node[key]; } catch (_) {}
    });
    ["itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "layoutGrow"].forEach(function (key) {
      try { if (typeof node[key] === "number" && Number.isFinite(node[key])) summary[key] = node[key]; } catch (_) {}
    });
    return summary;
  }
  function findPageNode(id) {
    if (typeof id !== "string" || !id.trim()) return null;
    return figma.currentPage.findOne(function (item) { return item.id === id; }) || null;
  }
  function findPageNodes(ids) {
    if (!Array.isArray(ids)) throw new Error("nodeIds must be an array.");
    var found = [];
    var seen = new Set();
    ids.forEach(function (id) {
      if (typeof id !== "string" || !id.trim() || seen.has(id)) throw new Error("nodeIds must contain unique non-empty IDs.");
      seen.add(id);
      var node = findPageNode(id);
      if (!node) throw new Error("Node not found on the current page: " + id);
      found.push(node);
    });
    return found;
  }
  function requireCanvasNode(nodeId, actionName) {
    var node = findPageNode(nodeId);
    if (!node) throw new Error(actionName + ": node not found on the current page. Read the canvas first and use a current-page node ID.");
    if (node.type === "DOCUMENT" || node.type === "PAGE") throw new Error(actionName + ": document and page roots cannot be modified by this operation.");
    return node;
  }
  function colorValue(hex) {
    var color = parseHexColor(hex);
    if (!color) throw new Error("Color must be a six-digit hex value such as #2563EB.");
    return color;
  }
  function setSolidPaint(node, property, hex) {
    if (!(property in node)) throw new Error("This node type does not support " + property + ".");
    node[property] = [{ type: "SOLID", color: colorValue(hex) }];
  }
  function clampUnit(value, fallback) {
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
  }
  function gradientTransformForAngle(angle) {
    // 0° runs left→right, 90° top→bottom. Rotates the gradient axis about the node centre.
    var radians = (Number.isFinite(angle) ? angle : 90) * Math.PI / 180;
    var cos = Math.cos(radians), sin = Math.sin(radians);
    return [[cos, sin, 0.5 - 0.5 * cos - 0.5 * sin], [-sin, cos, 0.5 + 0.5 * sin - 0.5 * cos]];
  }
  function buildNativePaints(list) {
    if (!Array.isArray(list) || list.length > 8) throw new Error("paints must be an array of up to 8 paints.");
    return list.map(function (paint, index) {
      if (!paint || typeof paint !== "object") throw new Error("Paint " + (index + 1) + " is invalid.");
      var visible = paint.visible !== false;
      if (paint.type === "SOLID") {
        return { type: "SOLID", color: colorValue(paint.color), opacity: clampUnit(paint.opacity, 1), visible: visible };
      }
      if (["GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"].includes(paint.type)) {
        if (!Array.isArray(paint.stops) || paint.stops.length < 2 || paint.stops.length > 8) {
          throw new Error("Gradient paint " + (index + 1) + " needs 2–8 stops.");
        }
        var stops = paint.stops.map(function (stop) {
          var rgb = colorValue(stop && stop.color);
          return { position: clampUnit(stop.position, 0), color: { r: rgb.r, g: rgb.g, b: rgb.b, a: clampUnit(stop.opacity, 1) } };
        }).sort(function (a, b) { return a.position - b.position; });
        return {
          type: paint.type, gradientStops: stops, visible: visible, opacity: clampUnit(paint.opacity, 1),
          gradientTransform: paint.type === "GRADIENT_LINEAR" ? gradientTransformForAngle(paint.angle) : [[1, 0, 0], [0, 1, 0]]
        };
      }
      throw new Error("Unsupported paint type: " + String(paint.type));
    });
  }
  function buildNativeEffects(list) {
    if (!Array.isArray(list) || list.length > 8) throw new Error("effects must be an array of up to 8 effects.");
    return list.map(function (effect, index) {
      if (!effect || typeof effect !== "object") throw new Error("Effect " + (index + 1) + " is invalid.");
      var visible = effect.visible !== false;
      if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
        var rgb = colorValue(effect.color);
        var shadow = {
          type: effect.type, visible: visible, blendMode: "NORMAL",
          color: { r: rgb.r, g: rgb.g, b: rgb.b, a: clampUnit(effect.opacity, 0.25) },
          offset: { x: Number.isFinite(effect.x) ? effect.x : 0, y: Number.isFinite(effect.y) ? effect.y : 4 },
          radius: Number.isFinite(effect.blur) ? Math.max(0, effect.blur) : 12,
          spread: Number.isFinite(effect.spread) ? effect.spread : 0
        };
        if (effect.type === "DROP_SHADOW") shadow.showShadowBehindNode = false;
        return shadow;
      }
      if (effect.type === "LAYER_BLUR" || effect.type === "BACKGROUND_BLUR") {
        return { type: effect.type, visible: visible, radius: Math.max(0, Math.min(250, Number(effect.radius) || 0)), blurType: "NORMAL" };
      }
      throw new Error("Unsupported effect type: " + String(effect.type));
    });
  }
  function assignNativeEffects(target, effects) {
    try { target.effects = effects; }
    catch (effectError) {
      // Older runtimes reject the blurType field; retry once without it.
      target.effects = effects.map(function (effect) {
        if (effect.blurType === undefined) return effect;
        var copy = Object.assign({}, effect); delete copy.blurType; return copy;
      });
    }
  }
  function buildNativeLayoutGrids(list) {
    if (!Array.isArray(list) || list.length > 6) throw new Error("layoutGrids must be an array of up to 6 grids.");
    return list.map(function (grid, index) {
      var rgb = parseHexColor(grid && grid.color) || { r: 1, g: 0, b: 0 };
      var color = { r: rgb.r, g: rgb.g, b: rgb.b, a: clampUnit(grid && grid.opacity, 0.1) };
      if (grid && grid.pattern === "GRID") {
        return { pattern: "GRID", sectionSize: Math.max(1, Number(grid.sectionSize) || 8), visible: true, color: color };
      }
      if (!grid || !["COLUMNS", "ROWS"].includes(grid.pattern) || !["MIN", "MAX", "CENTER", "STRETCH"].includes(grid.alignment)) {
        throw new Error("Layout grid " + (index + 1) + " needs pattern COLUMNS/ROWS/GRID and a valid alignment.");
      }
      var out = { pattern: grid.pattern, alignment: grid.alignment, count: Math.max(1, Math.min(48, grid.count | 0)),
        gutterSize: Math.max(0, Number(grid.gutterSize) || 0), visible: true, color: color };
      if (grid.alignment !== "CENTER") out.offset = Math.max(0, Number(grid.offset) || 0);
      if (grid.alignment !== "STRETCH") {
        if (!Number.isFinite(grid.sectionSize)) throw new Error("Layout grid " + (index + 1) + " with " + grid.alignment + " alignment needs sectionSize.");
        out.sectionSize = Math.max(1, grid.sectionSize);
      }
      return out;
    });
  }
  async function resolveComponentForInstance(componentId, actionName) {
    if (typeof componentId !== "string" || !componentId.trim()) throw new Error(actionName + " requires componentId.");
    var componentNode = await figma.getNodeByIdAsync(componentId);
    if (!componentNode) throw new Error(actionName + ": component " + componentId + " was not found in this file. Read the component catalogue first.");
    if (componentNode.type === "COMPONENT_SET") componentNode = componentNode.defaultVariant || componentNode.children[0];
    if (!componentNode || componentNode.type !== "COMPONENT") throw new Error(actionName + ": componentId must identify a COMPONENT or COMPONENT_SET.");
    return componentNode;
  }
  function resolveInstancePropertyKey(definitions, requested) {
    if (Object.prototype.hasOwnProperty.call(definitions, requested)) return requested;
    var matches = Object.keys(definitions).filter(function (key) { return key.split("#")[0] === requested; });
    if (matches.length === 1) return matches[0];
    var available = Object.keys(definitions).map(function (key) { return key.split("#")[0]; }).join(", ");
    throw new Error(matches.length ? "Property name " + requested + " is ambiguous; use its full key." :
      "Instance has no property " + requested + ". Available: " + (available || "none") + ".");
  }
  // lenient (generated screens): skip a property the component doesn't have instead of failing the build.
  function applyInstanceProperties(instance, requested, lenient) {
    if (!requested || typeof requested !== "object" || Array.isArray(requested)) {
      if (lenient) return [];
      throw new Error("instanceProperties must be an object.");
    }
    var definitions = instance.componentProperties || {};
    var resolved = {};
    Object.keys(requested).slice(0, 30).forEach(function (name) {
      var key;
      try { key = resolveInstancePropertyKey(definitions, name); }
      catch (error) { if (lenient) return; throw error; }
      var definition = definitions[key];
      var value = requested[name];
      if (lenient && definition.type === "BOOLEAN" && typeof value === "string" && /^(true|false)$/i.test(value)) value = /^true$/i.test(value);
      if (lenient && ((definition.type === "BOOLEAN") !== (typeof value === "boolean"))) return;
      if (definition.type === "BOOLEAN" && typeof value !== "boolean") throw new Error("Property " + name + " expects true/false.");
      if (definition.type !== "BOOLEAN" && typeof value !== "string") throw new Error("Property " + name + " expects a string value.");
      resolved[key] = value;
    });
    if (!Object.keys(resolved).length) return [];
    try { instance.setProperties(resolved); }
    catch (error) {
      // A model-invented variant value ("State=Hover" on a set without Hover) made setProperties
      // abort the whole generated screen. Leniently apply each property alone, keep the ones Figma
      // accepts and leave the rest on the default variant. Explicit edits still report the error.
      if (!lenient) throw error;
      Object.keys(resolved).forEach(function (key) {
        var single = {}; single[key] = resolved[key];
        try { instance.setProperties(single); } catch (_) { delete resolved[key]; }
      });
    }
    return Object.keys(resolved);
  }
  function buildNativeReaction(spec, index) {
    if (!spec || typeof spec !== "object") throw new Error("Reaction " + (index + 1) + " is invalid.");
    var trigger;
    if (spec.trigger === "AFTER_TIMEOUT") trigger = { type: "AFTER_TIMEOUT", timeout: Math.max(0, Math.min(60, Number(spec.timeout) || 0.8)) };
    else if (spec.trigger === "MOUSE_ENTER" || spec.trigger === "MOUSE_LEAVE") trigger = { type: spec.trigger, delay: Math.max(0, Math.min(60, Number(spec.timeout) || 0)) };
    else if (["ON_CLICK", "ON_HOVER", "ON_PRESS", "ON_DRAG"].includes(spec.trigger)) trigger = { type: spec.trigger };
    else throw new Error("Unsupported reaction trigger: " + String(spec.trigger));
    var transition = null;
    if (spec.transition && spec.transition.type && spec.transition.type !== "INSTANT") {
      transition = { type: spec.transition.type,
        easing: { type: spec.transition.easing || "EASE_OUT" },
        duration: Number.isFinite(spec.transition.duration) ? Math.max(0, Math.min(10, spec.transition.duration)) : 0.3 };
      if (["MOVE_IN", "MOVE_OUT", "PUSH", "SLIDE_IN", "SLIDE_OUT"].includes(spec.transition.type)) {
        if (!spec.transition.direction) throw new Error("Directional transitions need direction.");
        transition.direction = spec.transition.direction;
        transition.matchLayers = false;
      }
    }
    var action;
    if (spec.action === "BACK" || spec.action === "CLOSE") action = { type: spec.action };
    else if (spec.action === "URL") {
      if (typeof spec.url !== "string" || !/^https?:\/\//i.test(spec.url)) throw new Error("URL reactions need an http(s) url.");
      action = { type: "URL", url: spec.url.slice(0, 500) };
    } else if (["NAVIGATE", "OVERLAY", "SWAP", "SCROLL_TO"].includes(spec.action)) {
      var destination = findPageNode(spec.destinationId);
      if (!destination) throw new Error("Reaction destination " + String(spec.destinationId) + " was not found on the current page.");
      action = { type: "NODE", destinationId: destination.id, navigation: spec.action, transition: transition,
        preserveScrollPosition: false };
    } else throw new Error("Unsupported reaction action: " + String(spec.action));
    return { trigger: trigger, actions: [action] };
  }
  function isDescendantOf(node, ancestor) {
    var cursor = node && node.parent;
    while (cursor) { if (cursor.id === ancestor.id) return true; cursor = cursor.parent; }
    return false;
  }
  async function loadAndSetTextFont(node, spec) {
    if (node.type !== "TEXT") throw new Error("Typography and text edits can only be applied to TEXT nodes.");
    var fontFamily = typeof spec.fontFamily === "string" && spec.fontFamily.trim() ? spec.fontFamily.trim().slice(0, 100) : null;
    var fontStyle = typeof spec.fontStyle === "string" && spec.fontStyle.trim() ? spec.fontStyle.trim().slice(0, 100) : null;
    var current = node.fontName;
    var font = {
      family: fontFamily || (current && typeof current === "object" && current.family ? current.family : "Inter"),
      style: fontStyle || (current && typeof current === "object" && current.style ? current.style : "Regular")
    };
    await figma.loadFontAsync(font);
    node.fontName = font;
    return font;
  }
  async function applyTextStyleAsync(node, styleId) {
    if (node.type !== "TEXT" || typeof styleId !== "string" || !styleId) return false;
    try {
      var style = await figma.getStyleByIdAsync(styleId);
      if (!style || style.type !== "TEXT") return false;
      await figma.loadFontAsync(style.fontName);
      if (typeof node.setTextStyleIdAsync === "function") await node.setTextStyleIdAsync(styleId);
      else node.textStyleId = styleId;
      return true;
    } catch (_) {
      // The literal font/size already match the style; a missing style must not abort the design.
      return false;
    }
  }
  async function createInstanceFallbackFrame(spec) {
    var frame = figma.createFrame();
    frame.layoutMode = "HORIZONTAL";
    frame.itemSpacing = 12;
    frame.paddingTop = 12; frame.paddingBottom = 12; frame.paddingLeft = 16; frame.paddingRight = 16;
    frame.counterAxisAlignItems = "CENTER";
    frame.fills = [];
    var values = [];
    [spec.textOverrides, spec.instanceProperties].forEach(function (source) {
      if (!source || typeof source !== "object") return;
      Object.keys(source).forEach(function (key) {
        var value = source[key];
        if (typeof value === "string" && value.trim() && !/^(true|false)$/i.test(value) && values.indexOf(value) < 0 &&
            !/^(default|inner|primary|secondary|on|off|small|medium|large|property \d+)$/i.test(value.trim())) values.push(value);
      });
    });
    var font = { family: "Inter", style: "Semi Bold" };
    try { await figma.loadFontAsync(font); } catch (_) { font = { family: "Inter", style: "Regular" }; await figma.loadFontAsync(font); }
    for (var v = 0; v < values.length && v < 6; v++) {
      var text = figma.createText();
      text.fontName = font;
      text.fontSize = 16;
      text.characters = values[v].slice(0, 500);
      frame.appendChild(text);
    }
    return frame;
  }
  async function applyInstanceTextOverrides(instance, overrides) {
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return 0;
    var applied = 0;
    var texts = instance.findAll(function (child) { return child.type === "TEXT"; });
    // "__title": a new screen reusing the file's app bar sets its title, the instance's largest text.
    if (typeof overrides.__title === "string" && overrides.__title.trim() && texts.length) {
      var titleNode = texts.filter(function (tx) { return tx.visible !== false; }).sort(function (a, b) {
        var sa = a.fontSize === figma.mixed ? 0 : a.fontSize, sb = b.fontSize === figma.mixed ? 0 : b.fontSize;
        return sb - sa;
      })[0];
      if (titleNode && titleNode.characters !== overrides.__title) {
        var titleFonts = titleNode.fontName === figma.mixed ? titleNode.getRangeAllFontNames(0, titleNode.characters.length) : [titleNode.fontName];
        for (var tf = 0; tf < titleFonts.length; tf++) await figma.loadFontAsync(titleFonts[tf]);
        titleNode.characters = overrides.__title.slice(0, 200);
        applied += 1;
      }
    }
    for (var t = 0; t < texts.length; t++) {
      var textNode = texts[t];
      if (!Object.prototype.hasOwnProperty.call(overrides, textNode.name)) continue;
      var value = overrides[textNode.name];
      if (typeof value !== "string" || textNode.characters === value) continue;
      var fonts = textNode.fontName === figma.mixed ? textNode.getRangeAllFontNames(0, textNode.characters.length) : [textNode.fontName];
      for (var f = 0; f < fonts.length; f++) await figma.loadFontAsync(fonts[f]);
      textNode.characters = value.slice(0, 5000);
      applied += 1;
    }
    return applied;
  }
  function applyCreateProperties(node, spec) {
    if (Number.isFinite(spec.opacity) && "opacity" in node) node.opacity = Math.max(0, Math.min(1, spec.opacity));
    if (Number.isFinite(spec.rotation) && "rotation" in node) node.rotation = Math.max(-360, Math.min(360, spec.rotation));
    if (spec.arcData !== undefined) {
      if (node.type !== "ELLIPSE") throw new Error("arcData is supported only on ELLIPSE nodes.");
      var arc = spec.arcData;
      if (!arc || !Number.isFinite(arc.startingAngle) || !Number.isFinite(arc.endingAngle) ||
          !Number.isFinite(arc.innerRadius) || arc.endingAngle <= arc.startingAngle ||
          arc.startingAngle < -Math.PI * 2 || arc.startingAngle > Math.PI * 2 ||
          arc.endingAngle < -Math.PI * 2 || arc.endingAngle > Math.PI * 2 ||
          arc.innerRadius < 0 || arc.innerRadius > 1) {
        throw new Error("ELLIPSE arcData requires valid radian angles and an innerRadius from 0 to 1.");
      }
      node.arcData = {
        startingAngle: arc.startingAngle,
        endingAngle: arc.endingAngle,
        innerRadius: arc.innerRadius
      };
    }
    if (node.type === "FRAME" && spec.noFill === true && "fills" in node) node.fills = [];
    else if (typeof spec.color === "string" && "fills" in node) setSolidPaint(node, "fills", spec.color);
    if (typeof spec.strokeColor === "string" && "strokes" in node) setSolidPaint(node, "strokes", spec.strokeColor);
    if (Number.isFinite(spec.strokeWeight) && "strokeWeight" in node) node.strokeWeight = Math.max(0, Math.min(100, spec.strokeWeight));
    if (Number.isFinite(spec.cornerRadius) && "cornerRadius" in node) node.cornerRadius = Math.max(0, Math.min(512, spec.cornerRadius));
    if (typeof spec.clipsContent === "boolean" && "clipsContent" in node) node.clipsContent = spec.clipsContent;
    // dynamic-page files need the async setter; the plain property is the fallback.
    if (typeof spec.paintStyleId === "string" && "fillStyleId" in node && typeof node.setFillStyleIdAsync !== "function") node.fillStyleId = spec.paintStyleId;
    // TEXT styles are applied asynchronously by applyTextStyleAsync (dynamic-page safe).
    if (typeof spec.effectStyleId === "string" && "effectStyleId" in node) node.effectStyleId = spec.effectStyleId;
    if (typeof spec.gridStyleId === "string" && "gridStyleId" in node) node.gridStyleId = spec.gridStyleId;
    if (typeof spec.layoutMode === "string" && "layoutMode" in node) node.layoutMode = spec.layoutMode;
    ["itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
      "primaryAxisAlignItems", "counterAxisAlignItems", "primaryAxisSizingMode", "counterAxisSizingMode"].forEach(function (key) {
      if (spec[key] !== undefined && key in node) node[key] = spec[key];
    });
    if (spec.layoutWrap !== undefined && node.type === "FRAME") {
      if (node.layoutMode !== "HORIZONTAL" && spec.layoutWrap === "WRAP") {
        throw new Error("layoutWrap=WRAP requires a horizontal Auto Layout FRAME.");
      }
      node.layoutWrap = spec.layoutWrap;
    }
    if (spec.horizontalConstraint !== undefined || spec.verticalConstraint !== undefined) {
      if (!("constraints" in node)) throw new Error("Responsive constraints require a node with a constraints property.");
      var constraints = Object.assign({}, node.constraints || {});
      if (spec.horizontalConstraint !== undefined) constraints.horizontal = spec.horizontalConstraint;
      if (spec.verticalConstraint !== undefined) constraints.vertical = spec.verticalConstraint;
      node.constraints = constraints;
    }
    if (node.type === "TEXT") {
      if (typeof spec.textAlignHorizontal === "string") node.textAlignHorizontal = spec.textAlignHorizontal;
      if (typeof spec.textAlignVertical === "string") node.textAlignVertical = spec.textAlignVertical;
      if (typeof spec.textAutoResize === "string") node.textAutoResize = spec.textAutoResize;
    }
    if (["shadowColor", "shadowBlur", "shadowX", "shadowY", "shadowSpread"].some(function (key) { return spec[key] !== undefined; })) {
      if (!("effects" in node)) throw new Error("This node type does not support effects.");
      var shadow = parseHexColor(typeof spec.shadowColor === "string" ? spec.shadowColor : "#000000");
      node.effects = [{
        type: "DROP_SHADOW",
        color: { r: shadow.r, g: shadow.g, b: shadow.b, a: 0.16 },
        offset: { x: Number.isFinite(spec.shadowX) ? spec.shadowX : 0, y: Number.isFinite(spec.shadowY) ? spec.shadowY : 4 },
        radius: Number.isFinite(spec.shadowBlur) ? Math.max(0, Math.min(200, spec.shadowBlur)) : 12,
        spread: Number.isFinite(spec.shadowSpread) ? Math.max(-200, Math.min(200, spec.shadowSpread)) : 0,
        visible: true,
        blendMode: "NORMAL"
      }];
    }
  }

  if (payload.operation === "create-tree") {
    // Whole nested plan in one bridge round trip: each UI↔plugin message costs far more
    // than creating the layers, and a 60-layer screen used ~40 of them.
    if (!Array.isArray(payload.elements) || payload.elements.length < 1) throw new Error("create-tree requires elements.");
    var treeCount = 0;
    (function countTree(items, depth) {
      if (depth > 5) throw new Error("create-tree exceeded the safe nesting depth.");
      items.forEach(function (item) {
        treeCount += 1;
        if (item && Array.isArray(item.children)) countTree(item.children, depth + 1);
      });
    })(payload.elements, 0);
    if (treeCount > 200) throw new Error("create-tree accepts at most 200 layers.");
    var treeCreated = 0;
    async function buildTree(parentId, items) {
      var cursor = 0;
      while (cursor < items.length) {
        var item = items[cursor];
        if (Array.isArray(item.children) && item.children.length) {
          if (item.type !== "FRAME") throw new Error("Only native FRAME containers may have child layers.");
          var frameSpec = Object.assign({}, item);
          delete frameSpec.children;
          var made = await writeCanvasCommand({ confirm: true, operation: "create-elements", target: "node", parentNodeId: parentId, elements: [frameSpec] }, options);
          var madeNode = made && Array.isArray(made.nodes) ? made.nodes[0] : null;
          if (!madeNode || typeof madeNode.id !== "string") throw new Error("Figma did not return a native frame ID for " + item.name + ".");
          treeCreated += 1;
          await buildTree(madeNode.id, item.children);
          cursor += 1;
          continue;
        }
        var leaves = [];
        while (cursor < items.length && leaves.length < 20 && !(Array.isArray(items[cursor].children) && items[cursor].children.length)) {
          var leaf = Object.assign({}, items[cursor]);
          delete leaf.children;
          leaves.push(leaf);
          cursor += 1;
        }
        var leafResult = await writeCanvasCommand({ confirm: true, operation: "create-elements", target: "node", parentNodeId: parentId, elements: leaves }, options);
        treeCreated += Number(leafResult && leafResult.createdCount) || leaves.length;
      }
    }
    await buildTree(payload.parentNodeId, payload.elements);
    return { ok: true, operation: "create-tree", fileKey: figma.fileKey, pageName: figma.currentPage.name, createdCount: treeCreated };
  }

  if (payload.operation === "batch") {
    if (!Array.isArray(payload.actions) || payload.actions.length < 1 || payload.actions.length > 40) {
      throw new Error("batch requires 1 to 40 validated actions.");
    }
    if (payload.actions.some(function (step) {
      return step && ["export-svg", "export-node", "create-image-fill", "insert-image"].includes(step.operation);
    }) && payload.actions.length > 1) {
      throw new Error("Exports and image insertion with inline image data must be standalone commands to preserve bridge size limits.");
    }
    var batchResults = [];
    for (var batchIndex = 0; batchIndex < payload.actions.length; batchIndex++) {
      assertUxDirectFileScope("canvas batch step " + (batchIndex + 1));
      var step = payload.actions[batchIndex];
      if (!step || typeof step !== "object" || Array.isArray(step) || typeof step.operation !== "string" || step.operation === "batch") {
        return { ok: false, operation: "batch", state: batchResults.length ? "partial" : "failed",
          completedCount: batchResults.length, failedIndex: batchIndex, error: "Invalid or nested batch action.",
          results: batchResults };
      }
      try {
        var stepResult = await writeCanvasCommand(Object.assign({}, step, { confirm: true }));
        batchResults.push({ index: batchIndex, operation: step.operation, result: stepResult });
      } catch (batchError) {
        return { ok: false, operation: "batch", state: batchResults.length ? "partial" : "failed",
          completedCount: batchResults.length, failedIndex: batchIndex, failedOperation: step.operation,
          error: batchError && batchError.message ? String(batchError.message).slice(0, 900) : "Batch step failed.",
          results: batchResults };
      }
    }
    return { ok: true, operation: "batch", state: "completed", fileKey: figma.fileKey,
      pageName: figma.currentPage.name, completedCount: batchResults.length, results: batchResults };
  }

  if (payload.operation === "create-elements") {
    if (!Array.isArray(payload.elements) || payload.elements.length < 1 || payload.elements.length > 20) {
      throw new Error("create-elements requires 1 to 20 validated elements.");
    }
    var parent = await resolveCanvasWriteParent(payload.target || "current-page", payload.parentNodeId);
    var created = [];
    for (var i = 0; i < payload.elements.length; i++) {
      assertUxDirectFileScope("create canvas element");
      var spec = payload.elements[i] || {};
      var type = spec.type;
      if (typeof spec.name !== "string" || !spec.name.trim()) throw new Error("Every created element requires a name.");
      var node;
      if (type === "FRAME") node = figma.createFrame();
      else if (type === "RECTANGLE") node = figma.createRectangle();
      else if (type === "ELLIPSE") node = figma.createEllipse();
      else if (type === "TEXT") node = figma.createText();
      else if (type === "LINE") node = figma.createLine();
      else if (type === "POLYGON") node = figma.createPolygon();
      else if (type === "STAR") node = figma.createStar();
      else if (type === "SLICE") node = figma.createSlice();
      else if (type === "VECTOR") node = figma.createVector();
      else if (type === "CLONE") {
        // A copy of a source layer (logo, icon, chart, image) so variations keep real assets.
        var cloneOf = typeof spec.sourceNodeId === "string" ? await figma.getNodeByIdAsync(spec.sourceNodeId) : null;
        if (!cloneOf || typeof cloneOf.clone !== "function" || cloneOf.type === "PAGE" || cloneOf.type === "DOCUMENT") {
          throw new Error("CLONE source layer " + String(spec.sourceNodeId) + " was not found.");
        }
        node = cloneOf.clone();
        if (spec.monochrome && typeof spec.monochrome === "object") await monochromeClone(node, spec.monochrome);
      }
      else if (type === "INSTANCE") {
        try {
          node = (await resolveComponentForInstance(spec.componentId, "create-elements INSTANCE")).createInstance();
        } catch (instanceError) {
          // A missing/unpublished component must not abort the design: keep its text as native layers.
          node = await createInstanceFallbackFrame(spec);
          type = "FRAME";
          spec = Object.assign({}, spec, { type: "FRAME", instanceProperties: undefined, textOverrides: undefined });
        }
      }
      else throw new Error("Unsupported element type: " + String(type));
      node.name = spec.name.trim().slice(0, 80);
      // Marks layers UX Direct created so "revert" may delete them and nothing else.
      if (typeof node.setPluginData === "function") node.setPluginData("uxdCreated", "1");
      var width = Number.isFinite(spec.width) ? spec.width : (type === "TEXT" ? 280 : type === "INSTANCE" || type === "CLONE" ? node.width : 160);
      var height = Number.isFinite(spec.height) ? spec.height : (type === "TEXT" ? 40 : type === "INSTANCE" || type === "CLONE" ? node.height : 100);
      width = Math.max(1, Math.min(4096, width));
      height = Math.max(1, Math.min(4096, height));
      if (type === "CLONE") {
        // Keep the source proportions; only scale down when the plan gives a smaller slot.
        if (node.width > 0 && width < node.width - 0.5 && typeof node.rescale === "function") {
          try { node.rescale(width / node.width); } catch (_) {}
        }
      }
      // Instances keep their component's intrinsic size unless the plan sets one explicitly.
      else if (typeof node.resize === "function" && (type !== "INSTANCE" || Number.isFinite(spec.width) || Number.isFinite(spec.height))) node.resize(width, height);
      if (type === "INSTANCE" && spec.instanceProperties) applyInstanceProperties(node, spec.instanceProperties, true);
      if (type === "INSTANCE" && spec.textOverrides) await applyInstanceTextOverrides(node, spec.textOverrides);
      if (type === "INSTANCE" && spec.monochrome && typeof spec.monochrome === "object") await monochromeClone(node, spec.monochrome);
      if (type === "VECTOR") {
        if (!Array.isArray(spec.vectorPaths) || spec.vectorPaths.length < 1 || spec.vectorPaths.length > 20) {
          throw new Error("VECTOR elements require 1–20 vectorPaths.");
        }
        node.vectorPaths = spec.vectorPaths.map(function (path) {
          if (!path || !["EVENODD", "NONZERO"].includes(path.windingRule) || typeof path.data !== "string" || !path.data.trim()) {
            throw new Error("Each vector path requires a windingRule and path data.");
          }
          return { windingRule: path.windingRule, data: path.data.slice(0, 20000) };
        });
      }
      if (type === "POLYGON" && Number.isInteger(spec.pointCount)) node.pointCount = Math.max(3, Math.min(100, spec.pointCount));
      if (type === "STAR") {
        if (Number.isInteger(spec.pointCount)) node.pointCount = Math.max(3, Math.min(100, spec.pointCount));
        if (Number.isFinite(spec.innerRadius)) node.innerRadius = Math.max(0.01, Math.min(1, spec.innerRadius));
      }
      if (type === "TEXT") {
        var requestedFont = {
          family: typeof spec.fontFamily === "string" ? spec.fontFamily : "Inter",
          style: typeof spec.fontStyle === "string" ? spec.fontStyle : "Regular"
        };
        var font = requestedFont;
        try {
          await figma.loadFontAsync(requestedFont);
        } catch (fontError) {
          // Missing family/style should not abort an otherwise useful design. Record
          // a visible diagnostic and fall back to a dependable native font.
          font = { family: "Inter", style: "Regular" };
          try { await figma.loadFontAsync(font); }
          catch (_) { throw new Error("Could not load requested font or Inter Regular for " + node.name + "."); }
        }
        node.fontName = font;
        node.fontSize = Number.isFinite(spec.fontSize) ? Math.max(8, Math.min(144, spec.fontSize)) : 14;
        node.characters = spec.text.slice(0, 5000);
        if (typeof spec.textCase === "string") node.textCase = spec.textCase;
        if (typeof spec.textDecoration === "string") node.textDecoration = spec.textDecoration;
      }
      // A clone keeps the source layer's own paints, effects and layout.
      if (type !== "CLONE") applyCreateProperties(node, spec);
      if (type === "TEXT" && typeof spec.textStyleId === "string") await applyTextStyleAsync(node, spec.textStyleId);
      if (type !== "CLONE" && typeof spec.paintStyleId === "string" && typeof node.setFillStyleIdAsync === "function") {
        try { await node.setFillStyleIdAsync(spec.paintStyleId); } catch (_) { /* keep the literal colour */ }
      }
      if (type !== "CLONE" && typeof spec.strokeStyleId === "string" && typeof node.setStrokeStyleIdAsync === "function") {
        try { await node.setStrokeStyleIdAsync(spec.strokeStyleId); } catch (_) { /* keep the literal colour */ }
      }
      parent.appendChild(node);
      if (type === "CLONE" && "layoutPositioning" in node && spec.layoutPositioning !== "ABSOLUTE") {
        try { node.layoutPositioning = "AUTO"; } catch (_) {}
        // A copy keeps its source size; source FILL/STRETCH settings must not squash it here.
        try { if ("layoutGrow" in node) node.layoutGrow = 0; } catch (_) {}
        try { if ("layoutAlign" in node) node.layoutAlign = "INHERIT"; } catch (_) {}
      }

      var parentLayoutMode = parent && typeof parent.layoutMode === "string" ? parent.layoutMode : "NONE";
      var inAutoLayout = parentLayoutMode !== "NONE";
      if (inAutoLayout && "layoutPositioning" in node && spec.layoutPositioning === "ABSOLUTE") {
        node.layoutPositioning = "ABSOLUTE";
      }
      if (inAutoLayout && spec.layoutPositioning !== "ABSOLUTE") {
        [["layoutSizingHorizontal", spec.layoutSizingHorizontal],
          ["layoutSizingVertical", spec.layoutSizingVertical]].forEach(function (entry) {
          var property = entry[0], value = entry[1];
          if (value === undefined || !(property in node)) return;
          try { node[property] = value; }
          catch (layoutError) {
            // An impossible FILL/HUG must not abort the design; keep the node at its planned fixed size.
            if (value !== "FIXED") { try { node[property] = "FIXED"; } catch (_) {} }
          }
        });
      }
      // x/y must not be assigned to normal Auto Layout children. Figma ignores these
      // coordinates while laying them out and may make a broken plan look verified.
      // Absolute overlays and free-positioned children keep their local coordinates.
      if (!inAutoLayout || spec.layoutPositioning === "ABSOLUTE") {
        node.x = Number.isFinite(spec.x) ? Math.max(-100000, Math.min(100000, spec.x)) : 0;
        node.y = Number.isFinite(spec.y) ? Math.max(-100000, Math.min(100000, spec.y)) : i * (height + 24);
      }
      created.push(nodeSummary(node));
    }
    return { ok: true, operation: "create-elements", fileKey: figma.fileKey,
      pageName: parent.type === "PAGE" ? parent.name : (parent.parent && parent.parent.name) || figma.currentPage.name,
      target: payload.target || "current-page", createdCount: created.length, nodes: created };
  }

  if (payload.operation === "update-node") {
    var patch = payload.patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) {
      throw new Error("update-node requires a non-empty property patch.");
    }
    var targetNode = requireCanvasNode(payload.nodeId, "update-node");
    if (typeof patch.name === "string") targetNode.name = patch.name.slice(0, 120);
    if (typeof patch.visible === "boolean") targetNode.visible = patch.visible;
    if (Number.isFinite(patch.x) && "x" in targetNode) targetNode.x = Math.max(-10000, Math.min(10000, patch.x));
    if (Number.isFinite(patch.y) && "y" in targetNode) targetNode.y = Math.max(-10000, Math.min(10000, patch.y));
    if (Number.isFinite(patch.rotation) && "rotation" in targetNode) targetNode.rotation = Math.max(-360, Math.min(360, patch.rotation));
    if (patch.arcData !== undefined) {
      if (targetNode.type !== "ELLIPSE") throw new Error("arcData updates are supported only on ELLIPSE nodes.");
      var patchArc = patch.arcData;
      if (!patchArc || !Number.isFinite(patchArc.startingAngle) || !Number.isFinite(patchArc.endingAngle) ||
          !Number.isFinite(patchArc.innerRadius) || patchArc.endingAngle <= patchArc.startingAngle ||
          patchArc.startingAngle < -Math.PI * 2 || patchArc.startingAngle > Math.PI * 2 ||
          patchArc.endingAngle < -Math.PI * 2 || patchArc.endingAngle > Math.PI * 2 ||
          patchArc.innerRadius < 0 || patchArc.innerRadius > 1) {
        throw new Error("ELLIPSE arcData update requires valid radian angles and innerRadius from 0 to 1.");
      }
      targetNode.arcData = { startingAngle: patchArc.startingAngle, endingAngle: patchArc.endingAngle, innerRadius: patchArc.innerRadius };
    }
    if (Number.isFinite(patch.width) || Number.isFinite(patch.height)) {
      if (typeof targetNode.resize !== "function") throw new Error("This node type does not support resizing.");
      targetNode.resize(
        Number.isFinite(patch.width) ? Math.max(1, Math.min(4096, patch.width)) : targetNode.width,
        Number.isFinite(patch.height) ? Math.max(1, Math.min(4096, patch.height)) : targetNode.height
      );
    }
    if (Number.isFinite(patch.opacity)) {
      if (!("opacity" in targetNode)) throw new Error("This node type does not support opacity.");
      targetNode.opacity = Math.max(0, Math.min(1, patch.opacity));
    }
    if (typeof patch.fillColor === "string") setSolidPaint(targetNode, "fills", patch.fillColor);
    if (typeof patch.strokeColor === "string") setSolidPaint(targetNode, "strokes", patch.strokeColor);
    if (Number.isFinite(patch.strokeWeight)) {
      if (!("strokeWeight" in targetNode)) throw new Error("This node type does not support stroke weight.");
      targetNode.strokeWeight = Math.max(0, Math.min(100, patch.strokeWeight));
    }
    if (Number.isFinite(patch.cornerRadius)) {
      if (!("cornerRadius" in targetNode)) throw new Error("This node type does not support corner radius.");
      targetNode.cornerRadius = Math.max(0, Math.min(512, patch.cornerRadius));
    }
    if (typeof patch.clipsContent === "boolean") {
      if (!("clipsContent" in targetNode)) throw new Error("This node type does not support clipping content.");
      targetNode.clipsContent = patch.clipsContent;
    }
    var textPatch = ["text", "fontFamily", "fontStyle", "fontSize", "textAlignHorizontal", "textAlignVertical", "textAutoResize", "textCase", "textDecoration", "lineHeight", "letterSpacing"].some(function (key) { return patch[key] !== undefined; });
    if (textPatch) {
      await loadAndSetTextFont(targetNode, patch);
      if (typeof patch.text === "string") targetNode.characters = patch.text.slice(0, 5000);
      if (Number.isFinite(patch.fontSize)) targetNode.fontSize = Math.max(8, Math.min(144, patch.fontSize));
      if (patch.lineHeight && typeof patch.lineHeight === "object" &&
          ["PIXELS", "PERCENT"].includes(patch.lineHeight.unit) && Number.isFinite(patch.lineHeight.value)) {
        targetNode.lineHeight = { unit: patch.lineHeight.unit, value: Math.max(1, Math.min(500, patch.lineHeight.value)) };
      }
      if (patch.letterSpacing && typeof patch.letterSpacing === "object" &&
          ["PIXELS", "PERCENT"].includes(patch.letterSpacing.unit) && Number.isFinite(patch.letterSpacing.value)) {
        targetNode.letterSpacing = { unit: patch.letterSpacing.unit, value: Math.max(-100, Math.min(500, patch.letterSpacing.value)) };
      }
    }
    if (typeof patch.textAlignHorizontal === "string") {
      if (targetNode.type !== "TEXT") throw new Error("textAlignHorizontal can only be used on TEXT nodes.");
      targetNode.textAlignHorizontal = patch.textAlignHorizontal;
    }
    if (typeof patch.textAlignVertical === "string") {
      if (targetNode.type !== "TEXT") throw new Error("textAlignVertical can only be used on TEXT nodes.");
      targetNode.textAlignVertical = patch.textAlignVertical;
    }
    if (typeof patch.textAutoResize === "string") {
      if (targetNode.type !== "TEXT") throw new Error("textAutoResize can only be used on TEXT nodes.");
      targetNode.textAutoResize = patch.textAutoResize;
    }
    if (typeof patch.textCase === "string") {
      if (targetNode.type !== "TEXT") throw new Error("textCase can only be used on TEXT nodes.");
      targetNode.textCase = patch.textCase;
    }
    if (typeof patch.textDecoration === "string") {
      if (targetNode.type !== "TEXT") throw new Error("textDecoration can only be used on TEXT nodes.");
      targetNode.textDecoration = patch.textDecoration;
    }
    if (["shadowColor", "shadowBlur", "shadowX", "shadowY", "shadowSpread"].some(function (key) { return patch[key] !== undefined; })) {
      if (!("effects" in targetNode)) throw new Error("This node type does not support effects.");
      var shadow = parseHexColor(typeof patch.shadowColor === "string" ? patch.shadowColor : "#000000");
      targetNode.effects = [{
        type: "DROP_SHADOW",
        color: { r: shadow.r, g: shadow.g, b: shadow.b, a: 0.16 },
        offset: { x: Number.isFinite(patch.shadowX) ? patch.shadowX : 0, y: Number.isFinite(patch.shadowY) ? patch.shadowY : 4 },
        radius: Number.isFinite(patch.shadowBlur) ? Math.max(0, Math.min(200, patch.shadowBlur)) : 12,
        spread: Number.isFinite(patch.shadowSpread) ? Math.max(-200, Math.min(200, patch.shadowSpread)) : 0,
        visible: true,
        blendMode: "NORMAL"
      }];
    }
    var containerLayoutKeys = ["layoutMode", "layoutWrap", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
      "primaryAxisAlignItems", "counterAxisAlignItems", "primaryAxisSizingMode", "counterAxisSizingMode"];
    var hasContainerLayoutPatch = containerLayoutKeys.some(function (key) { return patch[key] !== undefined; });
    if (hasContainerLayoutPatch && !("layoutMode" in targetNode)) throw new Error("Container Auto Layout properties require a frame or component.");
    if (patch.layoutMode !== undefined) targetNode.layoutMode = patch.layoutMode;
    ["itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
      "primaryAxisAlignItems", "counterAxisAlignItems", "primaryAxisSizingMode", "counterAxisSizingMode"].forEach(function (key) {
      if (patch[key] !== undefined) targetNode[key] = patch[key];
    });
    if (patch.layoutWrap !== undefined) {
      if (targetNode.type !== "FRAME" || targetNode.layoutMode !== "HORIZONTAL") throw new Error("layoutWrap requires a horizontal Auto Layout FRAME.");
      targetNode.layoutWrap = patch.layoutWrap;
    }
    if (patch.layoutPositioning !== undefined) {
      var patchParent = targetNode.parent;
      if (!patchParent || !["HORIZONTAL", "VERTICAL", "GRID"].includes(String(patchParent.layoutMode))) {
        throw new Error("layoutPositioning requires a child of an Auto Layout frame.");
      }
      targetNode.layoutPositioning = patch.layoutPositioning;
    }
    [["layoutSizingHorizontal", patch.layoutSizingHorizontal], ["layoutSizingVertical", patch.layoutSizingVertical]].forEach(function (entry) {
      var property = entry[0], value = entry[1];
      if (value === undefined) return;
      var parentMode = targetNode.parent && targetNode.parent.layoutMode;
      if (!["HORIZONTAL", "VERTICAL", "GRID"].includes(String(parentMode))) throw new Error(property + " requires an Auto Layout parent.");
      if (!(property in targetNode)) throw new Error("Node does not support " + property + ".");
      targetNode[property] = value;
    });
    if (Number.isFinite(patch.layoutGrow)) {
      if (!("layoutGrow" in targetNode)) throw new Error("This node does not support layoutGrow.");
      targetNode.layoutGrow = Math.max(0, Math.min(1, patch.layoutGrow));
    }
    if (patch.horizontalConstraint !== undefined || patch.verticalConstraint !== undefined) {
      if (!( "constraints" in targetNode)) throw new Error("Constraints can only be set on nodes that support responsive constraints.");
      if (targetNode.parent && ["HORIZONTAL", "VERTICAL", "GRID"].includes(String(targetNode.parent.layoutMode))) {
        throw new Error("Do not combine Auto Layout and responsive constraints on the same child; use layoutSizing and layoutPositioning instead.");
      }
      var constraints = Object.assign({}, targetNode.constraints || {});
      if (patch.horizontalConstraint !== undefined) constraints.horizontal = patch.horizontalConstraint;
      if (patch.verticalConstraint !== undefined) constraints.vertical = patch.verticalConstraint;
      targetNode.constraints = constraints;
    }
    function setSupported(property, value, label) {
      if (value === undefined) return;
      if (!(property in targetNode)) throw new Error("This node type does not support " + (label || property) + ".");
      targetNode[property] = value;
    }
    setSupported("strokeAlign", patch.strokeAlign);
    if (patch.dashPattern !== undefined) setSupported("dashPattern", patch.dashPattern.slice(0, 8));
    ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"].forEach(function (key) {
      if (Number.isFinite(patch[key])) setSupported(key, Math.max(0, Math.min(100, patch[key])));
    });
    ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"].forEach(function (key) {
      if (Number.isFinite(patch[key])) setSupported(key, Math.max(0, Math.min(512, patch[key])));
    });
    if (Number.isFinite(patch.cornerSmoothing)) setSupported("cornerSmoothing", Math.max(0, Math.min(1, patch.cornerSmoothing)));
    ["minWidth", "maxWidth", "minHeight", "maxHeight"].forEach(function (key) {
      if (patch[key] === undefined) return;
      var parentMode = targetNode.parent && targetNode.parent.layoutMode;
      var ownMode = targetNode.layoutMode;
      if (!["HORIZONTAL", "VERTICAL", "GRID"].includes(String(parentMode)) && !["HORIZONTAL", "VERTICAL", "GRID"].includes(String(ownMode))) {
        throw new Error(key + " requires an Auto Layout frame or a child of one.");
      }
      setSupported(key, patch[key] === null ? null : Math.max(0, Math.min(4096, patch[key])));
    });
    if (patch.counterAxisSpacing !== undefined || patch.counterAxisAlignContent !== undefined) {
      if (targetNode.layoutWrap !== "WRAP") throw new Error("counterAxisSpacing/counterAxisAlignContent require a wrapping Auto Layout frame (layoutWrap=WRAP).");
      setSupported("counterAxisSpacing", patch.counterAxisSpacing);
      setSupported("counterAxisAlignContent", patch.counterAxisAlignContent);
    }
    setSupported("strokesIncludedInLayout", patch.strokesIncludedInLayout);
    setSupported("itemReverseZIndex", patch.itemReverseZIndex);
    setSupported("isMask", patch.isMask);
    setSupported("locked", patch.locked);
    setSupported("blendMode", patch.blendMode);
    if (patch.paragraphSpacing !== undefined) {
      if (targetNode.type !== "TEXT") throw new Error("paragraphSpacing can only be used on TEXT nodes.");
      if (!textPatch) await loadAndSetTextFont(targetNode, {});
      targetNode.paragraphSpacing = Math.max(0, Math.min(1000, patch.paragraphSpacing));
    }
    return { ok: true, operation: "update-node", fileKey: figma.fileKey,
      pageName: figma.currentPage.name, node: nodeSummary(targetNode) };
  }

  if (payload.operation === "clone-node") {
    var cloneSource = requireCanvasNode(payload.nodeId, "clone-node");
    var cloned = cloneSource.clone();
    // A duplicate sits right after its source in the same container (like Cmd+D), keeps its name, and
    // only gets an offset when the container does not lay it out (free-positioned parents).
    var cloneParent = cloneSource.parent;
    if (cloneParent && typeof cloneParent.insertChild === "function" && Array.isArray(cloneParent.children)) {
      var sourceIndex = cloneParent.children.indexOf(cloneSource);
      if (sourceIndex >= 0) cloneParent.insertChild(sourceIndex + 1, cloned);
    }
    cloned.name = String(cloneSource.name).slice(0, 120);
    var parentLaysOut = cloneParent && "layoutMode" in cloneParent && cloneParent.layoutMode && cloneParent.layoutMode !== "NONE";
    if (!parentLaysOut) {
      var stackedV = cloneParent && cloneParent.type !== "PAGE";
      if ("x" in cloned && "x" in cloneSource) cloned.x = stackedV ? cloneSource.x : cloneSource.x + 24;
      if ("y" in cloned && "y" in cloneSource) cloned.y = stackedV ? cloneSource.y + cloneSource.height + 12 : cloneSource.y + 24;
    }
    return { ok: true, operation: "clone-node", fileKey: figma.fileKey, pageName: figma.currentPage.name, node: nodeSummary(cloned) };
  }

  if (payload.operation === "delete-node") {
    var deleteTarget = requireCanvasNode(payload.nodeId, "delete-node");
    var deleted = { id: deleteTarget.id, name: deleteTarget.name, type: deleteTarget.type };
    deleteTarget.remove();
    return { ok: true, operation: "delete-node", fileKey: figma.fileKey, pageName: figma.currentPage.name, deleted: deleted };
  }

  if (payload.operation === "reparent-node") {
    var reparentTarget = requireCanvasNode(payload.nodeId, "reparent-node");
    var newParent = payload.parentNodeId === figma.currentPage.id
      ? figma.currentPage
      : findPageNode(payload.parentNodeId);
    if (!newParent) throw new Error("parentNodeId must identify a container on the current page.");
    if (newParent === reparentTarget) throw new Error("A node cannot be parented to itself.");
    if (typeof newParent.insertChild !== "function" || !Array.isArray(newParent.children)) {
      throw new Error("parentNodeId must be a page, frame, component, component set, or group that can contain children.");
    }
    var ancestor = newParent;
    while (ancestor) {
      if (ancestor.id === reparentTarget.id) throw new Error("Reparenting would create a cycle.");
      ancestor = ancestor.parent;
    }
    var insertAt = Number.isInteger(payload.index)
      ? Math.max(0, Math.min(newParent.children.length, payload.index))
      : newParent.children.length;
    newParent.insertChild(insertAt, reparentTarget);
    return { ok: true, operation: "reparent-node", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(reparentTarget), parent: { id: newParent.id, name: newParent.name, type: newParent.type },
      index: newParent.children.indexOf(reparentTarget) };
  }

  if (payload.operation === "reorder-node") {
    var reorderTarget = requireCanvasNode(payload.nodeId, "reorder-node");
    var reorderParent = reorderTarget.parent;
    if (!reorderParent || typeof reorderParent.insertChild !== "function" || !Array.isArray(reorderParent.children)) {
      throw new Error("This node cannot be reordered within its parent.");
    }
    var requestedIndex = Math.max(0, Math.min(reorderParent.children.length - 1, payload.index));
    reorderParent.insertChild(requestedIndex, reorderTarget);
    return { ok: true, operation: "reorder-node", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      index: reorderParent.children.indexOf(reorderTarget), node: nodeSummary(reorderTarget) };
  }

  if (payload.operation === "group-nodes") {
    var groupNodes = findPageNodes(payload.nodeIds);
    if (groupNodes.length < 2) throw new Error("Select at least two nodes to group.");
    var groupParent = groupNodes[0].parent;
    if (!groupParent || typeof groupParent.insertChild !== "function" ||
        groupNodes.some(function (node) { return node.parent !== groupParent; })) {
      throw new Error("Grouping requires sibling nodes with the same parent on the current page.");
    }
    var group = figma.group(groupNodes, groupParent);
    group.name = "Group";
    return { ok: true, operation: "group-nodes", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(group), childCount: group.children.length };
  }

  if (payload.operation === "flatten-nodes") {
    var flattenNodes = findPageNodes(payload.nodeIds || []);
    if (!flattenNodes.length) throw new Error("flatten-nodes requires one or more current-page nodes.");
    var flattenParent = flattenNodes[0].parent;
    if (!flattenParent || typeof flattenParent.insertChild !== "function" ||
        flattenNodes.some(function (node) { return node.parent !== flattenParent; })) {
      throw new Error("Flattening requires sibling nodes with the same parent on the current page.");
    }
    var flattened = figma.flatten(flattenNodes, flattenParent);
    return { ok: true, operation: "flatten-nodes", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(flattened), sourceNodeIds: flattenNodes.map(function (node) { return node.id; }) };
  }

  if (payload.operation === "boolean-operation") {
    var booleanNodes = findPageNodes(payload.nodeIds || []);
    if (booleanNodes.length < 2) throw new Error("boolean-operation requires at least two current-page nodes.");
    var booleanParent = booleanNodes[0].parent;
    if (!booleanParent || typeof booleanParent.insertChild !== "function" ||
        booleanNodes.some(function (node) { return node.parent !== booleanParent; })) {
      throw new Error("Boolean operations require sibling nodes with the same parent on the current page.");
    }
    var booleanType = payload.booleanOperation;
    var booleanResult;
    if (booleanType === "UNION") booleanResult = figma.union(booleanNodes, booleanParent);
    else if (booleanType === "SUBTRACT") booleanResult = figma.subtract(booleanNodes, booleanParent);
    else if (booleanType === "INTERSECT") booleanResult = figma.intersect(booleanNodes, booleanParent);
    else if (booleanType === "EXCLUDE") booleanResult = figma.exclude(booleanNodes, booleanParent);
    else throw new Error("booleanOperation must be UNION, SUBTRACT, INTERSECT, or EXCLUDE.");
    return { ok: true, operation: "boolean-operation", booleanOperation: booleanType,
      fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(booleanResult), sourceNodeIds: booleanNodes.map(function (node) { return node.id; }) };
  }

  if (payload.operation === "ungroup-node") {
    var ungroupTarget = requireCanvasNode(payload.nodeId, "ungroup-node");
    if (ungroupTarget.type !== "GROUP") throw new Error("ungroup-node requires a GROUP node.");
    var ungroupedIds = ungroupTarget.children.map(function (node) { return node.id; });
    figma.ungroup(ungroupTarget);
    return { ok: true, operation: "ungroup-node", fileKey: figma.fileKey, pageName: figma.currentPage.name, ungroupedIds: ungroupedIds };
  }

  if (payload.operation === "create-component") {
    var componentSource = requireCanvasNode(payload.nodeId, "create-component");
    if (componentSource.type !== "FRAME") throw new Error("create-component requires a FRAME node. Convert an eligible frame only.");
    if (typeof figma.createComponentFromNode !== "function") throw new Error("This Figma runtime does not expose createComponentFromNode.");
    var component = figma.createComponentFromNode(componentSource);
    return { ok: true, operation: "create-component", fileKey: figma.fileKey, pageName: figma.currentPage.name, node: nodeSummary(component) };
  }

  if (payload.operation === "create-component-set") {
    var variantComponents = findPageNodes(payload.nodeIds || []);
    if (variantComponents.length < 2) throw new Error("create-component-set requires at least two component nodes.");
    var variantParent = variantComponents[0].parent;
    if (!variantParent || typeof variantParent.insertChild !== "function" ||
        variantComponents.some(function (node) { return node.type !== "COMPONENT" || node.parent !== variantParent; })) {
      throw new Error("Variant sets require at least two sibling COMPONENT nodes on the current page.");
    }
    var variantSet = figma.combineAsVariants(variantComponents, variantParent);
    return { ok: true, operation: "create-component-set", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(variantSet), componentIds: variantSet.children.map(function (node) { return node.id; }) };
  }

  if (payload.operation === "create-instance") {
    var componentSourceNode = await resolveComponentForInstance(payload.nodeId, "create-instance");
    var instance = componentSourceNode.createInstance();
    if (payload.parentNodeId) {
      var instanceParent = findPageNode(payload.parentNodeId);
      if (!instanceParent || typeof instanceParent.insertChild !== "function" || !Array.isArray(instanceParent.children)) {
        instance.remove();
        throw new Error("create-instance parentNodeId must identify a container on the current page.");
      }
      var instanceIndex = Number.isInteger(payload.index) ? Math.max(0, Math.min(instanceParent.children.length, payload.index)) : instanceParent.children.length;
      instanceParent.insertChild(instanceIndex, instance);
      var instanceParentMode = typeof instanceParent.layoutMode === "string" ? instanceParent.layoutMode : "NONE";
      if (instanceParentMode !== "NONE") {
        if (payload.layoutSizingHorizontal) instance.layoutSizingHorizontal = payload.layoutSizingHorizontal;
        if (payload.layoutSizingVertical) instance.layoutSizingVertical = payload.layoutSizingVertical;
      } else {
        instance.x = Number.isFinite(payload.x) ? payload.x : 0;
        instance.y = Number.isFinite(payload.y) ? payload.y : 0;
      }
    } else {
      figma.currentPage.appendChild(instance);
      var onPage = componentSourceNode.parent && componentSourceNode.parent.type === "PAGE" && componentSourceNode.parent.id === figma.currentPage.id;
      instance.x = Number.isFinite(payload.x) ? payload.x : (onPage ? (componentSourceNode.x || 0) + (componentSourceNode.width || 0) + 24 : figma.viewport.center.x);
      instance.y = Number.isFinite(payload.y) ? payload.y : (onPage ? componentSourceNode.y || 0 : figma.viewport.center.y);
    }
    if (typeof payload.name === "string" && payload.name.trim()) instance.name = payload.name.trim().slice(0, 100);
    var appliedInstanceProperties = payload.instanceProperties ? applyInstanceProperties(instance, payload.instanceProperties) : [];
    return { ok: true, operation: "create-instance", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(instance), componentId: componentSourceNode.id, componentName: componentSourceNode.name,
      parentId: instance.parent ? instance.parent.id : null, appliedProperties: appliedInstanceProperties };
  }

  if (payload.operation === "swap-component") {
    var swapTarget = requireCanvasNode(payload.nodeId, "swap-component");
    if (swapTarget.type !== "INSTANCE") throw new Error("swap-component requires an INSTANCE node.");
    var componentNode = await resolveComponentForInstance(payload.componentId, "swap-component");
    swapTarget.swapComponent(componentNode);
    return { ok: true, operation: "swap-component", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(swapTarget), componentId: componentNode.id, componentName: componentNode.name };
  }

  if (payload.operation === "detach-instance") {
    var instanceTarget = requireCanvasNode(payload.nodeId, "detach-instance");
    if (instanceTarget.type !== "INSTANCE") throw new Error("detach-instance requires an INSTANCE node.");
    var detached = instanceTarget.detachInstance();
    return { ok: true, operation: "detach-instance", fileKey: figma.fileKey, pageName: figma.currentPage.name, node: nodeSummary(detached) };
  }

  if (payload.operation === "set-selection") {
    var selectionNodes = findPageNodes(payload.nodeIds || []);
    figma.currentPage.selection = selectionNodes;
    return { ok: true, operation: "set-selection", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      selection: selectionNodes.map(nodeSummary) };
  }

  if (payload.operation === "zoom-to-nodes") {
    var zoomNodes = findPageNodes(payload.nodeIds || []);
    if (!zoomNodes.length) throw new Error("zoom-to-nodes requires at least one valid node ID.");
    figma.viewport.scrollAndZoomIntoView(zoomNodes);
    return { ok: true, operation: "zoom-to-nodes", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      nodes: zoomNodes.map(nodeSummary), viewport: { zoom: figma.viewport.zoom, bounds: figma.viewport.bounds } };
  }

  if (payload.operation === "set-current-page") {
    var targetPage = figma.root.children.find(function (page) { return page.id === payload.pageId; });
    if (!targetPage) throw new Error("pageId must identify a page in the approved Figma file.");
    var previousPage = { id: figma.currentPage.id, name: figma.currentPage.name };
    await figma.setCurrentPageAsync(targetPage);
    return { ok: true, operation: "set-current-page", fileKey: figma.fileKey,
      previousPage: previousPage, page: { id: figma.currentPage.id, name: figma.currentPage.name } };
  }

  if (payload.operation === "create-page") {
    var newPageName = String(payload.pageName || "").trim().slice(0, 120);
    if (!newPageName) throw new Error("create-page requires a pageName.");
    var newPage = figma.createPage();
    newPage.name = newPageName;
    return { ok: true, operation: "create-page", fileKey: figma.fileKey, page: { id: newPage.id, name: newPage.name } };
  }

  if (payload.operation === "rename-page") {
    var pageName = String(payload.pageName || "").trim().slice(0, 120);
    if (!pageName) throw new Error("rename-page requires a pageName.");
    var previousPageName = figma.currentPage.name;
    figma.currentPage.name = pageName;
    return { ok: true, operation: "rename-page", fileKey: figma.fileKey,
      page: { id: figma.currentPage.id, previousName: previousPageName, name: figma.currentPage.name } };
  }

  if (payload.operation === "set-text-range") {
    var rangeTarget = requireCanvasNode(payload.nodeId, "set-text-range");
    if (rangeTarget.type !== "TEXT") throw new Error("set-text-range requires a TEXT node.");
    var range = payload.range;
    if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) ||
        range.start < 0 || range.end <= range.start || range.end > rangeTarget.characters.length) {
      throw new Error("Text range must satisfy 0 <= start < end <= text length.");
    }
    if (typeof rangeTarget.getRangeAllFontNames === "function") {
      await Promise.all(rangeTarget.getRangeAllFontNames(range.start, range.end).map(function (font) { return figma.loadFontAsync(font); }));
    }
    if (Number.isFinite(range.fontSize)) rangeTarget.setRangeFontSize(range.start, range.end, Math.max(8, Math.min(144, range.fontSize)));
    if (range.lineHeight) rangeTarget.setRangeLineHeight(range.start, range.end, {
      unit: range.lineHeight.unit, value: Math.max(1, Math.min(500, range.lineHeight.value))
    });
    if (range.letterSpacing) rangeTarget.setRangeLetterSpacing(range.start, range.end, {
      unit: range.letterSpacing.unit, value: Math.max(-100, Math.min(500, range.letterSpacing.value))
    });
    if (typeof range.fillColor === "string") rangeTarget.setRangeFills(range.start, range.end, [{
      type: "SOLID", color: colorValue(range.fillColor)
    }]);
    if (typeof range.fontFamily === "string" || typeof range.fontStyle === "string") {
      var currentRangeFont = rangeTarget.getRangeFontName(range.start, range.start + 1);
      var rangeFont = {
        family: typeof range.fontFamily === "string" ? range.fontFamily : currentRangeFont.family,
        style: typeof range.fontStyle === "string" ? range.fontStyle : currentRangeFont.style
      };
      await figma.loadFontAsync(rangeFont);
      rangeTarget.setRangeFontName(range.start, range.end, rangeFont);
    }
    if (typeof range.textDecoration === "string") rangeTarget.setRangeTextDecoration(range.start, range.end, range.textDecoration);
    if (typeof range.textCase === "string") rangeTarget.setRangeTextCase(range.start, range.end, range.textCase);
    if (range.hyperlink !== undefined) {
      if (range.hyperlink !== null && !/^https?:\/\//i.test(String(range.hyperlink))) throw new Error("hyperlink must be an http(s) URL or null.");
      rangeTarget.setRangeHyperlink(range.start, range.end, range.hyperlink === null ? null : { type: "URL", value: String(range.hyperlink).slice(0, 500) });
    }
    return { ok: true, operation: "set-text-range", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(rangeTarget), range: { start: range.start, end: range.end },
      applied: Object.keys(range).filter(function (key) { return !["start", "end"].includes(key); }) };
  }

  if (payload.operation === "insert-image") {
    if (typeof payload.imageBase64 !== "string" || payload.imageBase64.length < 4 || payload.imageBase64.length > 250000) {
      throw new Error("insert-image requires an attached base64 image under 250 KB.");
    }
    var imageParent = await resolveCanvasWriteParent(payload.target || "current-page", payload.parentNodeId);
    var imageBase64 = payload.imageBase64.replace(/^data:[^,]*;base64,/, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(imageBase64) || imageBase64.length % 4 !== 0) throw new Error("Attached image is not valid base64.");
    var imageBinary = atob(imageBase64);
    if (!imageBinary.length || imageBinary.length > 180000) throw new Error("Attached image must be under 180 KB after compression.");
    var imageBytes = new Uint8Array(imageBinary.length);
    for (var insertedIndex = 0; insertedIndex < imageBinary.length; insertedIndex++) imageBytes[insertedIndex] = imageBinary.charCodeAt(insertedIndex);
    var insertedImage = figma.createImage(imageBytes);
    var imageNode = figma.createRectangle();
    imageNode.name = (typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : "Image").slice(0, 100);
    imageNode.resize(Math.max(1, Math.min(4096, Number(payload.width) || 320)), Math.max(1, Math.min(4096, Number(payload.height) || 180)));
    if (Number.isFinite(payload.cornerRadius)) imageNode.cornerRadius = Math.max(0, Math.min(512, payload.cornerRadius));
    imageNode.fills = [{ type: "IMAGE", imageHash: insertedImage.hash,
      scaleMode: ["FILL", "FIT", "CROP", "TILE"].includes(payload.scaleMode) ? payload.scaleMode : "FILL" }];
    imageParent.appendChild(imageNode);
    var imageParentLayout = typeof imageParent.layoutMode === "string" ? imageParent.layoutMode : "NONE";
    if (imageParentLayout !== "NONE") {
      if (payload.layoutPositioning === "ABSOLUTE") {
        imageNode.layoutPositioning = "ABSOLUTE";
        imageNode.x = Number.isFinite(payload.x) ? Math.max(-10000, Math.min(10000, payload.x)) : 0;
        imageNode.y = Number.isFinite(payload.y) ? Math.max(-10000, Math.min(10000, payload.y)) : 0;
      } else {
        try {
          imageNode.layoutSizingHorizontal = payload.layoutSizingHorizontal || "FILL";
          imageNode.layoutSizingVertical = payload.layoutSizingVertical || "FIXED";
        } catch (sizeError) {
          throw new Error("Figma could not size the inserted image inside this Auto Layout parent: " + String(sizeError && sizeError.message || sizeError).slice(0, 160));
        }
      }
    } else {
      imageNode.x = Number.isFinite(payload.x) ? Math.max(-10000, Math.min(10000, payload.x)) : 0;
      imageNode.y = Number.isFinite(payload.y) ? Math.max(-10000, Math.min(10000, payload.y)) : 0;
    }
    return { ok: true, operation: "insert-image", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(imageNode), imageHash: insertedImage.hash, scaleMode: payload.scaleMode || "FILL", imageBytes: imageBytes.length };
  }

  if (payload.operation === "create-variables") {
    if (!figma.variables || typeof figma.variables.createVariableCollection !== "function") {
      throw new Error("This Figma runtime does not expose local variable creation.");
    }
    if (typeof payload.collectionName !== "string" || !payload.collectionName.trim() ||
        !Array.isArray(payload.variables) || payload.variables.length < 1 || payload.variables.length > 80) {
      throw new Error("create-variables requires collectionName and 1–80 named variables.");
    }
    var variableCollections = await figma.variables.getLocalVariableCollectionsAsync();
    var variableCollection = variableCollections.find(function (item) { return item.name === payload.collectionName; }) || null;
    if (!variableCollection) variableCollection = figma.variables.createVariableCollection(payload.collectionName.trim().slice(0, 100));
    var variableModeId = variableCollection.defaultModeId;
    if (typeof payload.modeName === "string" && payload.modeName.trim()) {
      var matchingMode = variableCollection.modes.find(function (item) { return item.name === payload.modeName; }) || null;
      if (matchingMode) variableModeId = matchingMode.modeId;
      else if (payload.modeName !== "Default" && typeof variableCollection.addMode === "function") {
        variableModeId = variableCollection.addMode(payload.modeName.trim().slice(0, 100));
      }
    }
    var localVariables = await figma.variables.getLocalVariablesAsync();
    var variableResults = [];
    for (var varIndex = 0; varIndex < payload.variables.length; varIndex++) {
      var varSpec = payload.variables[varIndex];
      if (!varSpec || typeof varSpec.name !== "string" || !varSpec.name.trim() ||
          !["COLOR", "FLOAT", "STRING", "BOOLEAN"].includes(varSpec.type)) {
        throw new Error("Each variable requires a name and a supported type (COLOR, FLOAT, STRING or BOOLEAN).");
      }
      var variable = localVariables.find(function (item) {
        return item.name === varSpec.name && item.variableCollectionId === variableCollection.id;
      }) || null;
      if (variable && variable.resolvedType !== varSpec.type) throw new Error("Existing variable " + varSpec.name + " has a different type.");
      if (!variable) {
        variable = figma.variables.createVariable(varSpec.name.trim().slice(0, 100), variableCollection, varSpec.type);
        localVariables.push(variable);
      }
      var value = varSpec.value;
      if (varSpec.type === "COLOR") {
        if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error("COLOR variable " + varSpec.name + " needs a #RRGGBB value.");
        value = colorValue(value);
      } else if (varSpec.type === "FLOAT" && (typeof value !== "number" || !Number.isFinite(value))) {
        throw new Error("FLOAT variable " + varSpec.name + " needs a number.");
      } else if (varSpec.type === "STRING" && typeof value !== "string") {
        throw new Error("STRING variable " + varSpec.name + " needs a string.");
      } else if (varSpec.type === "BOOLEAN" && typeof value !== "boolean") {
        throw new Error("BOOLEAN variable " + varSpec.name + " needs a boolean.");
      }
      variable.setValueForMode(variableModeId, value);
      variableResults.push({ id: variable.id, name: variable.name, type: variable.resolvedType, updated: true });
    }
    return { ok: true, operation: "create-variables", fileKey: figma.fileKey, collection: { id: variableCollection.id, name: variableCollection.name, modeId: variableModeId },
      variables: variableResults, createdOrUpdated: variableResults.length };
  }

  if (payload.operation === "bind-variable") {
    var bindingTarget = requireCanvasNode(payload.nodeId, "bind-variable");
    if (!figma.variables || typeof figma.variables.getLocalVariablesAsync !== "function") throw new Error("Figma local variable APIs are unavailable.");
    if (typeof payload.variableName !== "string" || !payload.variableName.trim() || typeof payload.property !== "string") {
      throw new Error("bind-variable requires variableName and property.");
    }
    var bindCollectionName = typeof payload.collectionName === "string" ? payload.collectionName.trim() : "";
    var bindVariables = await figma.variables.getLocalVariablesAsync();
    var targetBindingCollection = null;
    if (bindCollectionName) {
      if (typeof figma.variables.getLocalVariableCollectionsAsync !== "function") {
        throw new Error("This Figma runtime cannot resolve a variable collection by name.");
      }
      var bindingCollections = await figma.variables.getLocalVariableCollectionsAsync();
      targetBindingCollection = bindingCollections.find(function (collection) {
        return collection.name === bindCollectionName;
      }) || null;
      if (!targetBindingCollection) throw new Error("Local variable collection not found: " + bindCollectionName);
    }
    var boundVariable = bindVariables.find(function (item) {
      return item.name === payload.variableName &&
        (!targetBindingCollection || item.variableCollectionId === targetBindingCollection.id);
    }) || null;
    if (!boundVariable) throw new Error("Local variable not found: " + payload.variableName);
    if (payload.property === "fill" || payload.property === "stroke") {
      if (boundVariable.resolvedType !== "COLOR") throw new Error("fill/stroke bindings require a COLOR variable.");
      var paintProperty = payload.property === "fill" ? "fills" : "strokes";
      if (!(paintProperty in bindingTarget)) throw new Error("This node cannot accept a " + payload.property + " paint.");
      if (typeof figma.variables.setBoundVariableForPaint !== "function") throw new Error("This runtime cannot bind variables to individual paints.");
      var existingPaints = Array.isArray(bindingTarget[paintProperty]) ? bindingTarget[paintProperty] : [];
      var solidPaint = existingPaints.find(function (paint) { return paint && paint.type === "SOLID"; }) || {
        type: "SOLID", color: { r: 0.2, g: 0.2, b: 0.2 }
      };
      var boundPaint = figma.variables.setBoundVariableForPaint(solidPaint, "color", boundVariable);
      var otherPaints = existingPaints.filter(function (paint) { return paint !== solidPaint; });
      bindingTarget[paintProperty] = [boundPaint].concat(otherPaints);
    } else if (payload.property === "characters") {
      if (boundVariable.resolvedType !== "STRING") throw new Error("characters bindings require a STRING variable.");
      if (bindingTarget.type !== "TEXT") throw new Error("characters bindings require a TEXT node.");
      await Promise.all(bindingTarget.getRangeAllFontNames(0, Math.max(1, bindingTarget.characters.length)).map(function (font) { return figma.loadFontAsync(font); }));
      bindingTarget.setBoundVariable("characters", boundVariable);
    } else if (payload.property === "visible") {
      if (boundVariable.resolvedType !== "BOOLEAN") throw new Error("visible bindings require a BOOLEAN variable.");
      bindingTarget.setBoundVariable("visible", boundVariable);
    } else {
      if (boundVariable.resolvedType !== "FLOAT") throw new Error("Numeric layout/opacity bindings require a FLOAT variable.");
      var bindableProperties = { opacity: "opacity", cornerRadius: "cornerRadius", width: "width", height: "height",
        itemSpacing: "itemSpacing", paddingLeft: "paddingLeft", paddingRight: "paddingRight", paddingTop: "paddingTop", paddingBottom: "paddingBottom",
        strokeWeight: "strokeWeight", topLeftRadius: "topLeftRadius", topRightRadius: "topRightRadius",
        bottomLeftRadius: "bottomLeftRadius", bottomRightRadius: "bottomRightRadius", minWidth: "minWidth", maxWidth: "maxWidth",
        minHeight: "minHeight", maxHeight: "maxHeight", counterAxisSpacing: "counterAxisSpacing" };
      var bindProperty = bindableProperties[payload.property];
      if (!bindProperty || typeof bindingTarget.setBoundVariable !== "function") throw new Error("This node does not support binding " + payload.property + ".");
      if (!(bindProperty in bindingTarget)) throw new Error("This node does not expose property " + bindProperty + ".");
      bindingTarget.setBoundVariable(bindProperty, boundVariable);
    }
    return { ok: true, operation: "bind-variable", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(bindingTarget), variable: { id: boundVariable.id, name: boundVariable.name, type: boundVariable.resolvedType }, property: payload.property };
  }

  if (payload.operation === "create-image-fill") {
    var imageTarget = requireCanvasNode(payload.nodeId, "create-image-fill");
    if (!("fills" in imageTarget)) throw new Error("This node type does not support image fills.");
    if (typeof payload.imageBase64 !== "string" || payload.imageBase64.length < 4 || payload.imageBase64.length > 250000) {
      throw new Error("imageBase64 must contain a base64-encoded image under 250,000 characters.");
    }
    var cleanBase64 = payload.imageBase64.replace(/^data:[^,]*;base64,/, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBase64) || cleanBase64.length % 4 !== 0) {
      throw new Error("imageBase64 is not valid base64.");
    }
    var binaryImage = atob(cleanBase64);
    if (!binaryImage.length || binaryImage.length > 180000) throw new Error("Image data must be between 1 byte and 180 KB.");
    var imageBytes = new Uint8Array(binaryImage.length);
    for (var imageIndex = 0; imageIndex < binaryImage.length; imageIndex++) imageBytes[imageIndex] = binaryImage.charCodeAt(imageIndex);
    var imageResource = figma.createImage(imageBytes);
    imageTarget.fills = [{
      type: "IMAGE",
      imageHash: imageResource.hash,
      scaleMode: ["FILL", "FIT", "CROP", "TILE"].includes(payload.scaleMode) ? payload.scaleMode : "FILL"
    }];
    return { ok: true, operation: "create-image-fill", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(imageTarget), imageHash: imageResource.hash, scaleMode: payload.scaleMode || "FILL",
      imageBytes: imageBytes.length };
  }

  if (payload.operation === "apply-style") {
    var styleTarget = requireCanvasNode(payload.nodeId, "apply-style");
    var styleKind = payload.styleKind;
    var styleList;
    if (styleKind === "paint") styleList = await figma.getLocalPaintStylesAsync();
    else if (styleKind === "text") styleList = await figma.getLocalTextStylesAsync();
    else if (styleKind === "effect") styleList = await figma.getLocalEffectStylesAsync();
    else if (styleKind === "grid") styleList = await figma.getLocalGridStylesAsync();
    else throw new Error("styleKind must be paint, text, effect, or grid.");
    var chosenStyle = styleList.find(function (item) {
      return (payload.styleId && item.id === payload.styleId) || (!payload.styleId && payload.styleName && item.name === payload.styleName);
    });
    if (!chosenStyle) throw new Error("Local " + styleKind + " style was not found by the supplied ID/name.");
    var styleProperty = styleKind === "paint" ? "fillStyleId" :
      styleKind === "text" ? "textStyleId" :
      styleKind === "effect" ? "effectStyleId" : "gridStyleId";
    if (!(styleProperty in styleTarget)) throw new Error("This node type cannot accept a " + styleKind + " style.");
    if (styleKind === "text" && styleTarget.type !== "TEXT") throw new Error("Text styles can only be applied to TEXT nodes.");
    styleTarget[styleProperty] = chosenStyle.id;
    return { ok: true, operation: "apply-style", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      style: { id: chosenStyle.id, name: chosenStyle.name, type: styleKind }, node: nodeSummary(styleTarget) };
  }

  if (payload.operation === "wrap-in-auto-layout") {
    var wrapSpec = payload.autoLayout;
    if (!wrapSpec || !["HORIZONTAL", "VERTICAL"].includes(wrapSpec.layoutMode)) throw new Error("wrap-in-auto-layout requires autoLayout.layoutMode HORIZONTAL or VERTICAL.");
    var wrapNodes = findPageNodes(payload.nodeIds || []);
    if (!wrapNodes.length) throw new Error("wrap-in-auto-layout requires at least one node.");
    var wrapParent = wrapNodes[0].parent;
    if (!wrapParent || typeof wrapParent.insertChild !== "function" || !Array.isArray(wrapParent.children) ||
        wrapNodes.some(function (node) { return node.parent !== wrapParent; })) {
      throw new Error("wrap-in-auto-layout requires sibling nodes with the same parent.");
    }
    for (var wrapAncestor = wrapParent; wrapAncestor; wrapAncestor = wrapAncestor.parent) {
      if (wrapAncestor.type === "INSTANCE") throw new Error("Cannot restructure layers inside an instance; edit its main component instead.");
    }
    var parentIsAutoLayout = ["HORIZONTAL", "VERTICAL", "GRID"].includes(String(wrapParent.layoutMode));
    var horizontal = wrapSpec.layoutMode === "HORIZONTAL";
    // Keep the visual reading order: Auto Layout parents keep layer order, free layouts sort by position.
    var ordered = wrapNodes.slice().sort(function (a, b) {
      if (parentIsAutoLayout) return wrapParent.children.indexOf(a) - wrapParent.children.indexOf(b);
      return horizontal ? (a.x - b.x) || (a.y - b.y) : (a.y - b.y) || (a.x - b.x);
    });
    var minX = Math.min.apply(null, ordered.map(function (n) { return n.x; }));
    var minY = Math.min.apply(null, ordered.map(function (n) { return n.y; }));
    var maxX = Math.max.apply(null, ordered.map(function (n) { return n.x + n.width; }));
    var maxY = Math.max.apply(null, ordered.map(function (n) { return n.y + n.height; }));
    var inferredSpacing = null;
    if (ordered.length > 1 && !parentIsAutoLayout) {
      var gaps = [];
      for (var gapIndex = 1; gapIndex < ordered.length; gapIndex++) {
        var previous = ordered[gapIndex - 1], current = ordered[gapIndex];
        gaps.push(horizontal ? current.x - (previous.x + previous.width) : current.y - (previous.y + previous.height));
      }
      gaps.sort(function (a, b) { return a - b; });
      // Lower median, snapped to the 4px grid: loose rows 17px and 21px apart get 16, not 17.
      inferredSpacing = Math.max(0, Math.round(gaps[Math.floor((gaps.length - 1) / 2)] / 4) * 4);
    } else if (parentIsAutoLayout && typeof wrapParent.itemSpacing === "number") {
      inferredSpacing = wrapParent.itemSpacing;
    }
    var insertIndex = Math.min.apply(null, ordered.map(function (n) { return wrapParent.children.indexOf(n); }));
    var wrapper = figma.createFrame();
    wrapper.name = (typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : (horizontal ? "Row" : "Stack")).slice(0, 100);
    wrapper.clipsContent = false;
    wrapper.fills = typeof wrapSpec.fillColor === "string" ? [{ type: "SOLID", color: colorValue(wrapSpec.fillColor) }] : [];
    if (Number.isFinite(wrapSpec.cornerRadius)) wrapper.cornerRadius = wrapSpec.cornerRadius;
    wrapParent.insertChild(insertIndex, wrapper);
    if (!parentIsAutoLayout) {
      wrapper.x = minX; wrapper.y = minY;
      wrapper.resize(Math.max(1, maxX - minX), Math.max(1, maxY - minY));
    }
    wrapper.layoutMode = wrapSpec.layoutMode;
    var basePadding = Number.isFinite(wrapSpec.padding) ? wrapSpec.padding : 0;
    ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom"].forEach(function (key) {
      wrapper[key] = Number.isFinite(wrapSpec[key]) ? wrapSpec[key] : basePadding;
    });
    wrapper.itemSpacing = Number.isFinite(wrapSpec.itemSpacing) ? wrapSpec.itemSpacing : (inferredSpacing === null ? 0 : inferredSpacing);
    if (wrapSpec.primaryAxisAlignItems) wrapper.primaryAxisAlignItems = wrapSpec.primaryAxisAlignItems;
    if (wrapSpec.counterAxisAlignItems) wrapper.counterAxisAlignItems = wrapSpec.counterAxisAlignItems;
    wrapper.primaryAxisSizingMode = "AUTO";
    wrapper.counterAxisSizingMode = "AUTO";
    ordered.forEach(function (node) { wrapper.appendChild(node); });
    if (parentIsAutoLayout) {
      try { wrapper.layoutSizingHorizontal = wrapParent.layoutMode === "VERTICAL" ? "FILL" : "HUG"; } catch (_) {}
    }
    return { ok: true, operation: "wrap-in-auto-layout", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(wrapper), childIds: wrapper.children.map(function (node) { return node.id; }),
      childCount: wrapper.children.length, inferredItemSpacing: inferredSpacing };
  }

  if (payload.operation === "set-fills") {
    var paintTarget = requireCanvasNode(payload.nodeId, "set-fills");
    var paintKey = payload.paintProperty === "strokes" ? "strokes" : "fills";
    if (!(paintKey in paintTarget)) throw new Error("This node type does not support " + paintKey + ".");
    if (paintTarget.type === "TEXT" && paintKey === "fills" && Array.isArray(payload.paints) && payload.paints.length) {
      await Promise.all(paintTarget.getRangeAllFontNames(0, Math.max(1, paintTarget.characters.length)).map(function (font) { return figma.loadFontAsync(font); }));
    }
    paintTarget[paintKey] = buildNativePaints(payload.paints || []);
    return { ok: true, operation: "set-fills", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(paintTarget), paintProperty: paintKey,
      paintTypes: paintTarget[paintKey].map(function (paint) { return paint.type; }) };
  }

  if (payload.operation === "set-effects") {
    var effectTarget = requireCanvasNode(payload.nodeId, "set-effects");
    if (!("effects" in effectTarget)) throw new Error("This node type does not support effects.");
    assignNativeEffects(effectTarget, buildNativeEffects(payload.effects || []));
    return { ok: true, operation: "set-effects", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(effectTarget), effectTypes: effectTarget.effects.map(function (effect) { return effect.type; }) };
  }

  if (payload.operation === "set-layout-grids") {
    var gridTarget = requireCanvasNode(payload.nodeId, "set-layout-grids");
    if (!("layoutGrids" in gridTarget)) throw new Error("Layout grids require a FRAME, COMPONENT or INSTANCE.");
    gridTarget.layoutGrids = buildNativeLayoutGrids(payload.layoutGrids || []);
    return { ok: true, operation: "set-layout-grids", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(gridTarget), gridCount: gridTarget.layoutGrids.length };
  }

  if (payload.operation === "add-component-property") {
    var propertyOwner = requireCanvasNode(payload.nodeId, "add-component-property");
    var propertySpec = payload.componentProperty;
    if (!propertySpec || typeof propertySpec.name !== "string" || !propertySpec.name.trim()) throw new Error("componentProperty.name is required.");
    if (!["COMPONENT", "COMPONENT_SET"].includes(propertyOwner.type)) throw new Error("add-component-property requires a COMPONENT or COMPONENT_SET.");
    if (propertyOwner.type === "COMPONENT" && propertyOwner.parent && propertyOwner.parent.type === "COMPONENT_SET") {
      throw new Error("This component is a variant; add the property to its parent COMPONENT_SET (" + propertyOwner.parent.id + ").");
    }
    if (propertySpec.type === "VARIANT" && propertyOwner.type !== "COMPONENT_SET") throw new Error("VARIANT properties can only be added to a COMPONENT_SET.");
    var linkedNode = null;
    if (propertySpec.linkedNodeId) {
      linkedNode = findPageNode(propertySpec.linkedNodeId);
      if (!linkedNode || !isDescendantOf(linkedNode, propertyOwner)) throw new Error("linkedNodeId must be a layer inside the component.");
      if (propertySpec.type === "TEXT" && linkedNode.type !== "TEXT") throw new Error("TEXT properties link only to TEXT layers.");
      if (propertySpec.type === "INSTANCE_SWAP" && linkedNode.type !== "INSTANCE") throw new Error("INSTANCE_SWAP properties link only to nested instances.");
    }
    var defaultValue = propertySpec.defaultValue;
    // Preserve source content: a linked text property defaults to the layer's current text.
    if (defaultValue === undefined && propertySpec.type === "TEXT") defaultValue = linkedNode ? linkedNode.characters : propertySpec.name;
    if (defaultValue === undefined && propertySpec.type === "BOOLEAN") defaultValue = linkedNode ? linkedNode.visible !== false : true;
    if (propertySpec.type === "INSTANCE_SWAP") defaultValue = (await resolveComponentForInstance(String(defaultValue), "add-component-property")).id;
    var propertyKey = propertyOwner.addComponentProperty(propertySpec.name.trim().slice(0, 80), propertySpec.type, defaultValue);
    if (linkedNode) {
      var referenceField = propertySpec.type === "TEXT" ? "characters" : propertySpec.type === "BOOLEAN" ? "visible" : "mainComponent";
      var references = Object.assign({}, linkedNode.componentPropertyReferences || {});
      references[referenceField] = propertyKey;
      linkedNode.componentPropertyReferences = references;
    }
    return { ok: true, operation: "add-component-property", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(propertyOwner), propertyKey: propertyKey, propertyType: propertySpec.type,
      linkedNodeId: linkedNode ? linkedNode.id : null };
  }

  if (payload.operation === "set-instance-properties") {
    var propertyInstance = requireCanvasNode(payload.nodeId, "set-instance-properties");
    if (propertyInstance.type !== "INSTANCE") throw new Error("set-instance-properties requires an INSTANCE node.");
    var appliedKeys = applyInstanceProperties(propertyInstance, payload.instanceProperties);
    var currentProps = {};
    appliedKeys.forEach(function (key) {
      var entry = propertyInstance.componentProperties[key];
      if (entry) currentProps[key] = entry.value;
    });
    return { ok: true, operation: "set-instance-properties", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(propertyInstance), properties: currentProps };
  }

  if (payload.operation === "set-reactions") {
    var reactionTarget = requireCanvasNode(payload.nodeId, "set-reactions");
    if (!("reactions" in reactionTarget) || typeof reactionTarget.setReactionsAsync !== "function") {
      throw new Error("This node or runtime does not support prototype reactions.");
    }
    if (!Array.isArray(payload.reactions) || payload.reactions.length < 1 || payload.reactions.length > 10) throw new Error("set-reactions requires 1–10 reactions.");
    var newReactions = payload.reactions.map(buildNativeReaction);
    var existingReactions = payload.reactionMode === "replace" ? [] : (reactionTarget.reactions || []);
    await reactionTarget.setReactionsAsync(existingReactions.concat(newReactions));
    return { ok: true, operation: "set-reactions", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(reactionTarget), reactionCount: reactionTarget.reactions.length,
      mode: payload.reactionMode === "replace" ? "replace" : "append" };
  }

  if (payload.operation === "set-flow-start") {
    var flowNode = requireCanvasNode(payload.nodeId, "set-flow-start");
    if (!flowNode.parent || flowNode.parent.type !== "PAGE") throw new Error("Flow starting points must be top-level frames on the page.");
    var flowName = String(payload.flowName || flowNode.name).trim().slice(0, 120);
    var flows = (figma.currentPage.flowStartingPoints || []).filter(function (flow) { return flow.nodeId !== flowNode.id; });
    figma.currentPage.flowStartingPoints = flows.concat([{ nodeId: flowNode.id, name: flowName }]);
    return { ok: true, operation: "set-flow-start", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(flowNode), flowName: flowName, flowCount: figma.currentPage.flowStartingPoints.length };
  }

  if (payload.operation === "create-styles") {
    if (!Array.isArray(payload.styles) || payload.styles.length < 1 || payload.styles.length > 30) throw new Error("create-styles requires 1–30 style specs.");
    var localStyleLists = await Promise.all([figma.getLocalPaintStylesAsync(), figma.getLocalTextStylesAsync(), figma.getLocalEffectStylesAsync()]);
    var styleResults = [];
    for (var styleIndex = 0; styleIndex < payload.styles.length; styleIndex++) {
      var styleSpec = payload.styles[styleIndex];
      var styleName = String(styleSpec && styleSpec.name || "").trim().slice(0, 120);
      if (!styleName) throw new Error("Style " + (styleIndex + 1) + " needs a name.");
      var listIndex = styleSpec.kind === "paint" ? 0 : styleSpec.kind === "text" ? 1 : styleSpec.kind === "effect" ? 2 : -1;
      if (listIndex < 0) throw new Error("Style kind must be paint, text or effect.");
      var styleRecord = localStyleLists[listIndex].find(function (item) { return item.name === styleName; }) || null;
      var createdStyle = !styleRecord;
      if (styleSpec.kind === "paint") {
        var stylePaints = buildNativePaints(styleSpec.paints || []);
        if (!styleRecord) { styleRecord = figma.createPaintStyle(); styleRecord.name = styleName; localStyleLists[0].push(styleRecord); }
        styleRecord.paints = stylePaints;
      } else if (styleSpec.kind === "effect") {
        var styleEffects = buildNativeEffects(styleSpec.effects || []);
        if (!styleRecord) { styleRecord = figma.createEffectStyle(); styleRecord.name = styleName; localStyleLists[2].push(styleRecord); }
        assignNativeEffects(styleRecord, styleEffects);
      } else {
        var styleFont = { family: String(styleSpec.fontFamily || "Inter"), style: String(styleSpec.fontStyle || "Regular") };
        await figma.loadFontAsync(styleFont);
        if (!styleRecord) { styleRecord = figma.createTextStyle(); styleRecord.name = styleName; localStyleLists[1].push(styleRecord); }
        styleRecord.fontName = styleFont;
        styleRecord.fontSize = Math.max(1, Math.min(400, Number(styleSpec.fontSize) || 14));
        if (styleSpec.lineHeight) styleRecord.lineHeight = { unit: styleSpec.lineHeight.unit, value: styleSpec.lineHeight.value };
        if (styleSpec.letterSpacing) styleRecord.letterSpacing = { unit: styleSpec.letterSpacing.unit, value: styleSpec.letterSpacing.value };
        if (styleSpec.textCase) styleRecord.textCase = styleSpec.textCase;
        if (styleSpec.textDecoration) styleRecord.textDecoration = styleSpec.textDecoration;
      }
      styleResults.push({ id: styleRecord.id, name: styleRecord.name, kind: styleSpec.kind, created: createdStyle });
    }
    return { ok: true, operation: "create-styles", fileKey: figma.fileKey, styles: styleResults,
      createdCount: styleResults.filter(function (item) { return item.created; }).length,
      updatedCount: styleResults.filter(function (item) { return !item.created; }).length };
  }

  if (payload.operation === "set-variable-mode") {
    var modeTarget = requireCanvasNode(payload.nodeId, "set-variable-mode");
    if (typeof modeTarget.setExplicitVariableModeForCollection !== "function") throw new Error("This node does not support explicit variable modes.");
    var modeCollections = await figma.variables.getLocalVariableCollectionsAsync();
    var modeCollection = modeCollections.find(function (item) { return item.name === payload.collectionName; }) || null;
    if (!modeCollection) throw new Error("Local variable collection not found: " + String(payload.collectionName));
    var chosenMode = modeCollection.modes.find(function (mode) { return mode.name === payload.modeName; }) || null;
    if (!chosenMode) throw new Error("Mode " + String(payload.modeName) + " not found. Available: " + modeCollection.modes.map(function (mode) { return mode.name; }).join(", "));
    try { modeTarget.setExplicitVariableModeForCollection(modeCollection, chosenMode.modeId); }
    catch (_) { modeTarget.setExplicitVariableModeForCollection(modeCollection.id, chosenMode.modeId); }
    return { ok: true, operation: "set-variable-mode", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(modeTarget), collection: modeCollection.name, mode: chosenMode.name };
  }

  if (payload.operation === "export-node") {
    var genericExportTarget = requireCanvasNode(payload.nodeId, "export-node");
    var exportFormat = payload.format;
    if (!["PNG", "JPG", "PDF", "SVG_STRING"].includes(exportFormat)) throw new Error("export-node format must be PNG, JPG, PDF, or SVG_STRING.");
    if (exportFormat === "SVG_STRING") {
      var svgOutput = await genericExportTarget.exportAsync({ format: "SVG_STRING" });
      if (svgOutput.length > 35000) throw new Error("SVG export exceeds the safe 35 KB response limit; export a smaller node.");
      return { ok: true, operation: "export-node", fileKey: figma.fileKey, pageName: figma.currentPage.name,
        node: nodeSummary(genericExportTarget), format: exportFormat, byteLength: svgOutput.length, data: svgOutput };
    }
    var exportOptions = { format: exportFormat };
    var exportScale = 1;
    if ((exportFormat === "PNG" || exportFormat === "JPG") && isLocal && Number.isFinite(payload.maxSide) && payload.maxSide > 0) {
      // Local screen capture: size the export by its longest side instead of a fixed scale.
      var longestSide = Math.max(1, Number(genericExportTarget.width) || 1, Number(genericExportTarget.height) || 1);
      exportScale = Math.max(0.05, Math.min(2, Math.min(2000, payload.maxSide) / longestSide));
      exportOptions.constraint = { type: "SCALE", value: exportScale };
    } else if ((exportFormat === "PNG" || exportFormat === "JPG") && Number.isFinite(payload.scale)) {
      exportScale = Math.max(0.05, Math.min(1, payload.scale));
      exportOptions.constraint = { type: "SCALE", value: exportScale };
    }
    var exportBytes = await genericExportTarget.exportAsync(exportOptions);
    if (!(exportBytes instanceof Uint8Array)) throw new Error("Figma did not return encoded bytes for " + exportFormat + ".");
    var maxExportBytes = isLocal ? LOCAL_EXPORT_MAX_BYTES : 35000;
    if (exportBytes.length > maxExportBytes) throw new Error(exportFormat + " export exceeds the safe " + Math.round(maxExportBytes / 1000) + " KB binary response limit; export a smaller node.");
    var exportBase64;
    if (typeof figma.base64Encode === "function") exportBase64 = figma.base64Encode(exportBytes);
    else {
      var exportBinary = "";
      for (var exportIndex = 0; exportIndex < exportBytes.length; exportIndex += 1) exportBinary += String.fromCharCode(exportBytes[exportIndex]);
      exportBase64 = btoa(exportBinary);
    }
    if (!isLocal && exportBase64.length > 48000) throw new Error("Encoded export exceeds the safe result envelope.");
    return { ok: true, operation: "export-node", fileKey: figma.fileKey, pageName: figma.currentPage.name,
      node: nodeSummary(genericExportTarget), format: exportFormat, scale: exportScale, byteLength: exportBytes.length, base64: exportBase64 };
  }

  if (payload.operation === "export-svg") {
    var exportTarget = requireCanvasNode(payload.nodeId, "export-svg");
    if (typeof exportTarget.exportAsync !== "function") throw new Error("This node type does not support export.");
    var svg = await exportTarget.exportAsync({ format: "SVG_STRING" });
    if (typeof svg !== "string") throw new Error("Figma did not return SVG text for this node.");
    if (svg.length > 35000) throw new Error("SVG export exceeds the safe 35 KB response limit; export a smaller node.");
    return { ok: true, operation: "export-svg", fileKey: figma.fileKey,
      node: nodeSummary(exportTarget), format: "SVG_STRING", byteLength: svg.length, svg: svg };
  }

  throw new Error("Unsupported canvas write operation: " + String(payload.operation));
}
async function runCanvasCommand(command) {
  assertUxDirectFileScope("execute canvas command");
  var result = null;
  var errorText = null;
  try {
    if (!command || typeof command.commandId !== "string") throw new Error("Invalid canvas command envelope.");
    if (command.action === "read-canvas") result = await readCanvasCommand(command.payload);
    else if (command.action === "write-canvas") result = await writeCanvasCommand(command.payload, { local: command.local === true });
    else throw new Error("Unsupported canvas command action.");
  } catch (error) {
    errorText = error && error.message ? String(error.message).slice(0, 1000) : "Canvas command failed.";
  }
  figma.ui.postMessage({
    type: "canvas-command-result",
    commandId: command && command.commandId,
    result: result,
    error: errorText
  });
}

// Local quick-task channel: image bytes and large selection trees go straight between the plugin
// UI and this sandbox instead of through the backend bridge (whose results are capped at 60 KB).
// Only these named operations exist; every one checks the approved-file scope first.
var UXD_LOCAL_TASK_OPS = ["read-tree", "read-image", "apply-image", "restore-fills", "delete-created", "commit-undo", "trigger-undo", "apply-direct-edits", "apply-hygiene-fixes", "fill-realistic-data", "restore-texts", "restore-props", "find-icon-targets", "insert-icons", "section-state", "get-design-rules", "set-design-rules", "consistency", "restore-missing-texts", "detached-rescue", "handoff-notes", "prototype-wire", "learn-baseline", "learn-corrections", "apply-theme", "restore-theme-modes", "componentize-repeats"];
// Revert support: fills captured before each image change, kept for this plugin session.
var UXD_FILL_SNAPSHOTS = new Map();
var UXD_FILL_SNAPSHOT_SEQ = 0;
var UXD_LOCAL_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
async function localReadTree(payload) {
  var maxDepth = Math.max(0, Math.min(12, Number.isInteger(payload.maxDepth) ? payload.maxDepth : 6));
  var maxNodes = Math.max(1, Math.min(800, Number.isInteger(payload.maxNodes) ? payload.maxNodes : 500));
  var source = figma.currentPage.selection;
  if (Array.isArray(payload.nodeIds) && payload.nodeIds.length) {
    source = [];
    for (var n = 0; n < payload.nodeIds.length && n < 12; n++) {
      var picked = await figma.getNodeByIdAsync(String(payload.nodeIds[n]));
      if (picked && picked.type !== "PAGE" && picked.type !== "DOCUMENT") source.push(picked);
    }
  }
  var state = { count: 0, maxNodes: maxNodes, truncated: false, collapseInstances: payload.collapseInstances === true };
  var nodes = [];
  for (var i = 0; i < source.length; i++) {
    if (state.count >= maxNodes) { state.truncated = true; break; }
    var item = summarizeCanvasNode(source[i], maxDepth, state);
    if (item) nodes.push(item);
  }
  var counts = { paint: 0, text: 0, variables: 0 };
  try { counts.paint = (await figma.getLocalPaintStylesAsync()).length; } catch (_) {}
  try { counts.text = (await figma.getLocalTextStylesAsync()).length; } catch (_) {}
  try {
    if (figma.variables && typeof figma.variables.getLocalVariablesAsync === "function") {
      counts.variables = (await figma.variables.getLocalVariablesAsync()).length;
    }
  } catch (_) {}
  return { ok: true, pageName: figma.currentPage.name, nodeCount: state.count, truncated: state.truncated, nodes: nodes, styleCounts: counts };
}
async function localTaskNode(nodeId) {
  var node = typeof nodeId === "string" && nodeId ? await figma.getNodeByIdAsync(nodeId) : null;
  if (!node || node.type === "PAGE" || node.type === "DOCUMENT") throw new Error("The selected layer is no longer on this page.");
  var page = node;
  while (page && page.type !== "PAGE") page = page.parent;
  if (!page || page.id !== figma.currentPage.id) throw new Error("The target layer must be on the current page.");
  return node;
}
async function localReadImage(payload) {
  var node = await localTaskNode(payload.nodeId);
  var paints = "fills" in node && Array.isArray(node.fills) ? node.fills : [];
  var imagePaint = null;
  for (var i = paints.length - 1; i >= 0; i--) {
    if (paints[i] && paints[i].type === "IMAGE" && paints[i].visible !== false && paints[i].imageHash) { imagePaint = paints[i]; break; }
  }
  var bytes = null;
  var source = "export";
  if (imagePaint) {
    var image = figma.getImageByHash(imagePaint.imageHash);
    if (image) { bytes = await image.getBytesAsync(); source = "image-fill"; }
  }
  if (!bytes) {
    if (typeof node.exportAsync !== "function") throw new Error("This layer has no image and cannot be exported.");
    bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
  }
  if (!bytes || !bytes.length) throw new Error("Figma returned no image bytes.");
  if (bytes.length > UXD_LOCAL_IMAGE_MAX_BYTES) throw new Error("The image is larger than 12 MB.");
  return { ok: true, nodeId: node.id, name: node.name, source: source, bytes: bytes,
    width: node.width, height: node.height, scaleMode: imagePaint ? imagePaint.scaleMode : null };
}
async function localApplyImage(payload) {
  var node = await localTaskNode(payload.nodeId);
  if (node.type === "TEXT") throw new Error("Select a shape or frame, not a text layer, to place an image.");
  if (!("fills" in node)) throw new Error(node.type + " layers cannot hold an image fill.");
  var bytes = payload.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.length < 16 || bytes.length > UXD_LOCAL_IMAGE_MAX_BYTES) throw new Error("Image data is missing or larger than 12 MB.");
  var image = figma.createImage(bytes);
  var scaleMode = ["FILL", "FIT", "CROP", "TILE"].indexOf(payload.scaleMode) >= 0 ? payload.scaleMode : "FILL";
  var current = Array.isArray(node.fills) ? node.fills.slice() : [];
  var replaced = false;
  if (payload.mode === "replace-image") {
    for (var i = current.length - 1; i >= 0; i--) {
      if (current[i] && current[i].type === "IMAGE") {
        current[i] = Object.assign({}, current[i], { imageHash: image.hash });
        replaced = true;
        break;
      }
    }
  }
  var snapshotId = "fills-" + (++UXD_FILL_SNAPSHOT_SEQ);
  UXD_FILL_SNAPSHOTS.set(snapshotId, { nodeId: node.id, fills: JSON.parse(JSON.stringify(Array.isArray(node.fills) ? node.fills : [])) });
  if (UXD_FILL_SNAPSHOTS.size > 50) UXD_FILL_SNAPSHOTS.delete(UXD_FILL_SNAPSHOTS.keys().next().value);
  if (typeof figma.commitUndo === "function") figma.commitUndo();
  node.fills = replaced ? current : [{ type: "IMAGE", imageHash: image.hash, scaleMode: scaleMode }];
  if (typeof figma.commitUndo === "function") figma.commitUndo();
  return { ok: true, nodeId: node.id, name: node.name, imageHash: image.hash, replaced: replaced, snapshotId: snapshotId,
    width: node.width, height: node.height, bytes: bytes.length };
}
async function localRestoreFills(payload) {
  var snapshot = UXD_FILL_SNAPSHOTS.get(payload.snapshotId);
  if (!snapshot) throw new Error("The saved state for this change is gone (the plugin was reopened). Use Cmd/Ctrl+Z in Figma instead.");
  var node = await localTaskNode(snapshot.nodeId);
  if (typeof figma.commitUndo === "function") figma.commitUndo();
  node.fills = snapshot.fills;
  if (typeof figma.commitUndo === "function") figma.commitUndo();
  UXD_FILL_SNAPSHOTS.delete(payload.snapshotId);
  return { ok: true, nodeId: node.id, name: node.name };
}
async function localDeleteCreated(payload) {
  var ids = Array.isArray(payload.nodeIds) ? payload.nodeIds.slice(0, 20) : [];
  var deleted = [];
  var missing = [];
  for (var i = 0; i < ids.length; i++) {
    var node = await figma.getNodeByIdAsync(String(ids[i]));
    if (!node || node.removed) { missing.push(String(ids[i])); continue; }
    if (typeof node.getPluginData !== "function" || node.getPluginData("uxdCreated") !== "1") {
      throw new Error("\"" + node.name + "\" was not created by UX Direct, so revert will not delete it.");
    }
    deleted.push(node.name);
    node.remove();
  }
  if (typeof figma.commitUndo === "function") figma.commitUndo();
  return { ok: true, deleted: deleted, missing: missing };
}
// Direct edits: deterministic property changes parsed in the UI ("make text white", "padding 24",
// "add shadow", "duplicate this"). No model is involved, so these never fail on a model answer.
// Every op names a target ("text" = text layers in the selection, "self" = the selected layers,
// "bg" = the selected layers, or the parent of a selected text layer) and an optional noun
// ("button", "title") that narrows the target to matching layers inside the selection.
var UXD_DIRECT_NOUNS = {
  button: /\b(button|btn|cta)\b/i, icon: /\b(icon|ic|glyph|chevron|arrow)\b/i, card: /\bcard\b/i,
  header: /\b(header|top ?bar|app ?bar|nav ?bar|navbar|navigation|toolbar)\b/i, footer: /\b(footer|bottom ?bar|tab ?bar)\b/i,
  image: /\b(image|img|photo|picture|thumbnail|banner|illustration)\b/i, avatar: /\b(avatar|profile pic|profile photo)\b/i,
  divider: /\b(divider|separator|line|rule)\b/i, input: /\b(input|field|text ?field|search ?bar|textbox|dropdown)\b/i,
  tab: /\btabs?\b/i, chip: /\b(chip|badge|tag|pill)\b/i, list: /\b(list ?item|row|cell)\b/i, modal: /\b(modal|dialog|sheet|popup)\b/i,
  title: /\b(title|heading|headline|h1|h2)\b/i, subtitle: /\b(subtitle|sub ?title|subheading|sub ?heading)\b/i,
  label: /\blabel\b/i, caption: /\b(caption|helper|hint)\b/i, body: /\b(body|description|paragraph|desc)\b/i,
  link: /\blink\b/i, price: /\b(price|amount|value|total)\b/i
};
var UXD_TEXT_NOUNS = ["title", "subtitle", "label", "caption", "body", "link", "price"];
var UXD_FONT_LIST = null;
var UXD_WEIGHT_STYLES = {
  thin: ["Thin", "Hairline", "ExtraLight", "Extra Light", "UltraLight", "Light"],
  light: ["Light", "ExtraLight", "Extra Light", "Thin"],
  regular: ["Regular", "Book", "Normal", "Roman", "Text"],
  medium: ["Medium", "Regular"],
  semibold: ["SemiBold", "Semi Bold", "Semibold", "DemiBold", "Demi Bold", "Medium", "Bold"],
  bold: ["Bold", "SemiBold", "Semi Bold", "ExtraBold", "Extra Bold", "Heavy", "Black"],
  extrabold: ["ExtraBold", "Extra Bold", "Heavy", "Black", "Bold"],
  black: ["Black", "Heavy", "ExtraBold", "Extra Bold", "Bold"]
};
function uxdHexToRgb(hex) {
  var clean = String(hex || "").replace("#", "");
  if (clean.length === 3 || clean.length === 4) clean = clean.split("").map(function (c) { return c + c; }).join("");
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(clean)) throw new Error("Unknown colour " + hex + ".");
  return { r: parseInt(clean.slice(0, 2), 16) / 255, g: parseInt(clean.slice(2, 4), 16) / 255, b: parseInt(clean.slice(4, 6), 16) / 255,
    a: clean.length === 8 ? parseInt(clean.slice(6, 8), 16) / 255 : 1 };
}
function uxdSolid(hex) {
  var c = uxdHexToRgb(hex);
  return { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a, visible: true };
}
function uxdShiftColor(color, amount) {
  // amount > 0 lightens towards white, < 0 darkens towards black.
  function ch(v) { return amount >= 0 ? v + (1 - v) * amount : v * (1 + amount); }
  return { r: ch(color.r), g: ch(color.g), b: ch(color.b) };
}
function uxdIsContainer(node) { return node && ["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION", "GROUP"].indexOf(node.type) >= 0; }
function uxdHasAutoLayout(node) { return node && ["HORIZONTAL", "VERTICAL", "GRID"].indexOf(String(node.layoutMode)) >= 0; }
function uxdDescendants(node, test) {
  if (typeof node.findAll === "function") return node.findAll(test);
  var out = [];
  (function walk(n) { (n.children || []).forEach(function (c) { if (test(c)) out.push(c); walk(c); }); })(node);
  return out;
}
function uxdTextNodes(node) {
  if (node.type === "TEXT") return [node];
  return uxdDescendants(node, function (c) { return c.type === "TEXT" && c.visible !== false; });
}
function uxdInside(node, root) {
  for (var p = node; p; p = p.parent) if (p === root) return true;
  return false;
}
function uxdOffsetY(node, root) {
  var y = 0;
  for (var p = node; p && p !== root; p = p.parent) y += Number(p.y) || 0;
  return y;
}
function uxdPickOne(root, candidates) {
  var inRoot = candidates.filter(function (n) { return uxdInside(n, root); });
  if (inRoot.length <= 1) return inRoot[0] || null;
  var screenLevel = /\b(screen|page|header|app ?bar|nav ?bar|navigation|top ?bar|toolbar)\b/i;
  var preferred = inRoot.filter(function (n) {
    for (var p = n; p && p !== root.parent; p = p.parent) if (screenLevel.test(String(p.name || ""))) return true;
    return false;
  });
  var pool = preferred.length ? preferred : inRoot;
  pool.sort(function (a, b) {
    var dy = uxdOffsetY(a, root) - uxdOffsetY(b, root);
    if (Math.abs(dy) > 1) return dy;
    return (Number(b.fontSize) || 0) - (Number(a.fontSize) || 0);
  });
  return pool[0];
}
function uxdResolveTargets(roots, op) {
  var nodes = roots.slice();
  if (op.noun) {
    var pattern = UXD_DIRECT_NOUNS[op.noun];
    if (!pattern) return { error: "unknown target " + op.noun };
    var textNoun = UXD_TEXT_NOUNS.indexOf(op.noun) >= 0;
    var matched = [];
    roots.forEach(function (root) {
      var pool = [root].concat(uxdDescendants(root, function () { return true; }));
      pool.forEach(function (n) {
        if (!pattern.test(String(n.name || ""))) return;
        if (textNoun && n.type !== "TEXT" && !uxdIsContainer(n)) return;
        // Skip layers nested inside another match ("Button" > "Button label" counts once).
        var p = n.parent, nested = false;
        while (p && p !== root.parent) { if (matched.indexOf(p) >= 0) { nested = true; break; } p = p.parent; }
        if (!nested && matched.indexOf(n) < 0) matched.push(n);
      });
      if (!matched.length && (op.noun === "title")) {
        var texts = uxdTextNodes(root).filter(function (t) { return typeof t.fontSize === "number"; });
        texts.sort(function (a, b) { return b.fontSize - a.fontSize; });
        if (texts[0]) matched.push(texts[0]);
      }
    });
    // A selected component part ("the button" with the button itself selected) is the target.
    if (!matched.length && roots.every(function (r) { return r.parent && r.parent.type !== "PAGE"; })) matched = roots.slice();
    if (!matched.length) return { needsModel: true, reason: "no layer named like \"" + op.noun + "\" in the selection" };
    // "the title" (singular) is one layer per selected root: the screen/header one, else the topmost.
    if (op.single === true && matched.length > roots.length) {
      matched = roots.map(function (root) { return uxdPickOne(root, matched); }).filter(Boolean);
    }
    nodes = matched;
  }
  if (op.target === "text") {
    var texts = [];
    nodes.forEach(function (n) { uxdTextNodes(n).forEach(function (t) { if (texts.indexOf(t) < 0) texts.push(t); }); });
    if (!texts.length) return { error: "There is no text layer in the selection." };
    // Find/replace only touches the layers that contain the text.
    var replace = op.set && op.set.replace;
    if (replace && typeof replace.from === "string") {
      var needle = replace.from.toLowerCase();
      texts = texts.filter(function (t) { return String(t.characters || "").toLowerCase().indexOf(needle) >= 0; });
      if (!texts.length) return { error: "\"" + replace.from + "\" is not in the selection." };
    }
    // "the title" inside a matched header frame is its largest text, not the back arrow too.
    if (op.single === true && op.set && typeof op.set.text === "string" && texts.length > nodes.length) {
      texts = nodes.map(function (n) {
        return uxdTextNodes(n).slice().sort(function (a, b) { return (Number(b.fontSize) || 0) - (Number(a.fontSize) || 0); })[0];
      }).filter(Boolean);
    }
    // Setting one new text on many layers is never what "change the text to X" means: hand it to
    // the model, which can tell which layer is meant (finding 66).
    if (op.set && typeof op.set.text === "string" && texts.length > 1) {
      return { needsModel: true, reason: "the new text would replace " + texts.length + " different text layers" };
    }
    return { nodes: texts };
  }
  if (op.target === "bg") {
    return { nodes: nodes.map(function (n) { return n.type === "TEXT" && n.parent && n.parent.type !== "PAGE" ? n.parent : n; }) };
  }
  return { nodes: nodes };
}
async function uxdFontList() {
  if (UXD_FONT_LIST) return UXD_FONT_LIST;
  UXD_FONT_LIST = new Map();
  try {
    var fonts = typeof figma.listAvailableFontsAsync === "function" ? await figma.listAvailableFontsAsync() : [];
    fonts.forEach(function (f) {
      var key = f.fontName.family.toLowerCase();
      if (!UXD_FONT_LIST.has(key)) UXD_FONT_LIST.set(key, { family: f.fontName.family, styles: [] });
      UXD_FONT_LIST.get(key).styles.push(f.fontName.style);
    });
  } catch (_) { /* fall back to trying loadFontAsync directly */ }
  return UXD_FONT_LIST;
}
async function uxdTryFont(family, styles) {
  var list = await uxdFontList();
  var known = list.get(String(family).toLowerCase());
  var realFamily = known ? known.family : family;
  for (var i = 0; i < styles.length; i++) {
    if (known && known.styles.indexOf(styles[i]) < 0) continue;
    try { await uxdEnsureFont({ family: realFamily, style: styles[i] }); return { family: realFamily, style: styles[i] }; } catch (_) {}
  }
  return null;
}
function uxdWeightOf(style) {
  var s = String(style || "").toLowerCase().replace(/italic|oblique/g, "").replace(/\s+/g, "");
  if (/extrabold|ultrabold/.test(s)) return "extrabold";
  if (/semibold|demibold/.test(s)) return "semibold";
  if (/black|heavy/.test(s)) return "black";
  if (/bold/.test(s)) return "bold";
  if (/medium/.test(s)) return "medium";
  if (/extralight|ultralight|thin|hairline/.test(s)) return "thin";
  if (/light/.test(s)) return "light";
  return "regular";
}
function uxdStyleCandidates(weight, italic) {
  var base = UXD_WEIGHT_STYLES[weight] || UXD_WEIGHT_STYLES.regular;
  if (!italic) return base;
  var out = [];
  base.forEach(function (b) { out.push(b + " Italic", b + "Italic"); });
  if (weight === "regular") out.unshift("Italic");
  return out;
}
// Wireframe copies: every paint in a cloned logo/icon/chart becomes a grey of the same lightness,
// near-white marks (white icons made for a dark header) become the wireframe ink, and image fills
// become a flat placeholder grey. Runs on the copy only; the source layer is never touched.
function monoHexToRgb(hex) {
  var v = String(hex || "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(v)) return { r: 0.1, g: 0.1, b: 0.1 };
  return { r: parseInt(v.slice(0, 2), 16) / 255, g: parseInt(v.slice(2, 4), 16) / 255, b: parseInt(v.slice(4, 6), 16) / 255 };
}
function monoGrey(color, ink, isMark) {
  var l = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
  if (isMark && l > 0.8) return { r: ink.r, g: ink.g, b: ink.b };
  // Keep light tracks light and dark marks dark, without pure black.
  var g = Math.max(0.12, Math.min(0.92, l));
  return { r: g, g: g, b: g };
}
function monoPaints(paints, ink, placeholder, isMark) {
  if (!Array.isArray(paints)) return paints;
  return paints.map(function (p) {
    if (!p || p.visible === false) return p;
    // Drop variable bindings: a bound colour variable would override the grey (finding 52).
    if (p.type === "SOLID") { var solid = Object.assign({}, p, { color: monoGrey(p.color, ink, isMark) }); delete solid.boundVariables; return solid; }
    if (p.type === "IMAGE" || p.type === "VIDEO") return { type: "SOLID", color: placeholder, opacity: p.opacity === undefined ? 1 : p.opacity };
    if (p.type && p.type.indexOf("GRADIENT") === 0 && Array.isArray(p.gradientStops)) {
      return Object.assign({}, p, { gradientStops: p.gradientStops.map(function (s) {
        var c = monoGrey(s.color, ink, isMark); return Object.assign({}, s, { color: { r: c.r, g: c.g, b: c.b, a: s.color.a } });
      }) });
    }
    return p;
  });
}
async function monochromeClone(root, mono) {
  var ink = monoHexToRgb(mono.ink), placeholder = monoHexToRgb(mono.placeholder);
  var nodes = [root].concat(typeof root.findAll === "function" ? root.findAll(function () { return true; }) : []);
  for (var i = 0; i < nodes.length && i < 400; i++) {
    var n = nodes[i];
    var isMark = n.type !== "FRAME" && n.type !== "COMPONENT" && n.type !== "INSTANCE" && n.type !== "GROUP" && n.type !== "SECTION";
    try {
      if (n.type === "TEXT") {
        var len = n.characters.length;
        var fonts = len ? n.getRangeAllFontNames(0, len) : [n.fontName];
        for (var f = 0; f < fonts.length; f++) if (fonts[f] && typeof fonts[f] === "object") await uxdEnsureFont(fonts[f]);
      }
      if (n.type === "TEXT" && !Array.isArray(n.fills) && typeof n.getStyledTextSegments === "function") {
        // Mixed-colour text: recolour each styled run.
        var runs = n.getStyledTextSegments(["fills"]);
        for (var r = 0; r < runs.length; r++) n.setRangeFills(runs[r].start, runs[r].end, monoPaints(runs[r].fills, ink, placeholder, true));
      }
      if ("fills" in n && Array.isArray(n.fills) && n.fills.length) {
        if (n.fillStyleId && typeof n.setFillStyleIdAsync === "function") await n.setFillStyleIdAsync("");
        n.fills = monoPaints(n.fills, ink, placeholder, isMark);
      }
      if ("strokes" in n && Array.isArray(n.strokes) && n.strokes.length) {
        if (typeof n.strokeStyleId === "string" && n.strokeStyleId && typeof n.setStrokeStyleIdAsync === "function") await n.setStrokeStyleIdAsync("");
        n.strokes = monoPaints(n.strokes, ink, placeholder, isMark);
      }
    } catch (_) { /* instance sublayers that refuse overrides keep their paint */ }
  }
}
// Fonts this plugin session already loaded. Skipping the real loadFontAsync for them keeps the
// apply phase of a direct edit free of network waits, so Figma records it as ONE undo step.
var UXD_LOADED_FONTS = new Set();
function uxdFontKey(font) { return font && typeof font === "object" ? font.family + "\u0000" + font.style : ""; }
async function uxdEnsureFont(font) {
  var key = uxdFontKey(font);
  if (!key || UXD_LOADED_FONTS.has(key)) return;
  await figma.loadFontAsync(font);
  UXD_LOADED_FONTS.add(key);
}
async function uxdLoadTextFonts(node) {
  var length = typeof node.characters === "string" ? node.characters.length : 0;
  var fonts = length && typeof node.getRangeAllFontNames === "function" ? node.getRangeAllFontNames(0, length)
    : (node.fontName && typeof node.fontName === "object" ? [node.fontName] : []);
  for (var i = 0; i < fonts.length; i++) await uxdEnsureFont(fonts[i]);
}
// Load every font a direct edit will need BEFORE the first change. Font loading waits on the
// network; when it happens between two changes Figma splits the edit into separate undo steps
// (e.g. "24px bold" needed two Cmd+Z). Best effort: a font missed here is still loaded later.
async function uxdPrewarmDirectEditFonts(plan) {
  var needsList = plan.some(function (step) { return step.op.set && ("fontWeight" in step.op.set || "italic" in step.op.set || "fontFamily" in step.op.set); });
  if (needsList) await uxdFontList();
  for (var p = 0; p < plan.length; p++) {
    var step = plan[p];
    if (!step.op.set) continue;
    var key = Object.keys(step.op.set)[0];
    var value = step.op.set[key];
    for (var n = 0; n < step.nodes.length && n < 200; n++) {
      var node = step.nodes[n];
      if (!node || node.type !== "TEXT") continue;
      try { await uxdLoadTextFonts(node); } catch (_) { continue; }
      if (key !== "fontWeight" && key !== "italic" && key !== "fontFamily") continue;
      var segments = uxdFontSegments(node);
      for (var s = 0; s < segments.length; s++) {
        var current = segments[s].fontName && typeof segments[s].fontName === "object" ? segments[s].fontName : { family: "Inter", style: "Regular" };
        var italicNow = /italic|oblique/i.test(current.style);
        if (key === "fontFamily") {
          await uxdTryFont(value, [current.style].concat(uxdStyleCandidates(uxdWeightOf(current.style), italicNow), ["Regular"]));
        } else {
          await uxdTryFont(current.family, uxdStyleCandidates(key === "fontWeight" ? value : uxdWeightOf(current.style), key === "italic" ? value : italicNow));
        }
      }
    }
  }
}
function uxdFontSegments(node) {
  var length = typeof node.characters === "string" ? node.characters.length : 0;
  if (length && typeof node.getStyledTextSegments === "function") return node.getStyledTextSegments(["fontName", "fontSize"]);
  return [{ start: 0, end: length, fontName: node.fontName, fontSize: node.fontSize }];
}
async function uxdSetFonts(node, pick) {
  var segments = uxdFontSegments(node);
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    var current = seg.fontName && typeof seg.fontName === "object" ? seg.fontName : { family: "Inter", style: "Regular" };
    var next = await pick(current);
    if (!next) continue;
    if (segments.length === 1 || typeof node.setRangeFontName !== "function" || seg.end <= seg.start) node.fontName = next;
    else node.setRangeFontName(seg.start, seg.end, next);
  }
}
function uxdSetFontSize(node, compute) {
  var segments = uxdFontSegments(node);
  segments.forEach(function (seg) {
    var size = Math.max(6, Math.min(400, Math.round(compute(typeof seg.fontSize === "number" ? seg.fontSize : 14))));
    if (segments.length === 1 || typeof node.setRangeFontSize !== "function" || seg.end <= seg.start) node.fontSize = size;
    else node.setRangeFontSize(seg.start, seg.end, size);
  });
}
function uxdInferLayout(node) {
  var kids = (node.children || []).filter(function (c) { return c.visible !== false; });
  if (kids.length < 2) return { mode: "VERTICAL", gap: 0, ordered: kids };
  var byY = kids.slice().sort(function (a, b) { return a.y - b.y || a.x - b.x; });
  var byX = kids.slice().sort(function (a, b) { return a.x - b.x || a.y - b.y; });
  function stacks(list, horizontal) {
    for (var i = 1; i < list.length; i++) {
      var prev = list[i - 1], cur = list[i];
      if (horizontal ? cur.x < prev.x + prev.width - 1 : cur.y < prev.y + prev.height - 1) return false;
    }
    return true;
  }
  var vertical = stacks(byY, false), horizontal = stacks(byX, true);
  var mode = vertical ? "VERTICAL" : horizontal ? "HORIZONTAL" : null;
  if (!mode) return null;
  var ordered = mode === "VERTICAL" ? byY : byX;
  var gaps = [];
  for (var g = 1; g < ordered.length; g++) {
    gaps.push(mode === "VERTICAL" ? ordered[g].y - (ordered[g - 1].y + ordered[g - 1].height) : ordered[g].x - (ordered[g - 1].x + ordered[g - 1].width));
  }
  gaps.sort(function (a, b) { return a - b; });
  return { mode: mode, gap: Math.max(0, Math.round(gaps[Math.floor((gaps.length - 1) / 2)])), ordered: ordered };
}
function uxdEnableAutoLayout(node, direction) {
  if (uxdHasAutoLayout(node)) {
    if (direction && node.layoutMode !== direction) node.layoutMode = direction;
    return "";
  }
  if (!("layoutMode" in node) || node.type === "GROUP") throw new Error("\"" + node.name + "\" is a " + node.type.toLowerCase() + "; say \"wrap in auto layout\" to put it in an auto layout frame.");
  var inferred = uxdInferLayout(node);
  if (!inferred && !direction) throw new Error("The layers inside \"" + node.name + "\" overlap, so auto layout would move them. Say \"add vertical auto layout\" or \"add horizontal auto layout\" to force a direction.");
  var mode = direction || inferred.mode;
  var kids = inferred && inferred.mode === mode ? inferred.ordered : (node.children || []).slice().sort(function (a, b) { return mode === "VERTICAL" ? a.y - b.y : a.x - b.x; });
  var minX = Math.min.apply(null, kids.map(function (c) { return c.x; }).concat([0]));
  var minY = Math.min.apply(null, kids.map(function (c) { return c.y; }).concat([0]));
  kids.forEach(function (child, index) { if (typeof node.insertChild === "function") node.insertChild(index, child); });
  node.layoutMode = mode;
  node.itemSpacing = inferred && inferred.mode === mode ? inferred.gap : 0;
  if (kids.length) {
    node.paddingLeft = Math.max(0, Math.round(minX)); node.paddingRight = Math.max(0, Math.round(minX));
    node.paddingTop = Math.max(0, Math.round(minY)); node.paddingBottom = Math.max(0, Math.round(minY));
  }
  return "added " + mode.toLowerCase() + " auto layout to \"" + node.name + "\"";
}
var UXD_SHADOWS = {
  soft: { type: "DROP_SHADOW", y: 4, blur: 12, a: 0.12 }, small: { type: "DROP_SHADOW", y: 1, blur: 3, a: 0.14 },
  strong: { type: "DROP_SHADOW", y: 8, blur: 24, a: 0.24 }, inner: { type: "INNER_SHADOW", y: 2, blur: 4, a: 0.12 }
};
function uxdSetEffects(node, effects) {
  try { node.effects = effects; }
  catch (_) {
    node.effects = effects.map(function (e) { if (e.blurType === undefined) return e; var c = Object.assign({}, e); delete c.blurType; return c; });
  }
}
async function uxdApplySet(node, set, notes) {
  var key = Object.keys(set)[0];
  var value = set[key];
  function need(prop, label) { if (!(prop in node)) throw new Error("\"" + node.name + "\" (" + node.type.toLowerCase() + ") has no " + label + "."); }
  function needText() { if (node.type !== "TEXT") throw new Error("\"" + node.name + "\" is not a text layer."); }
  function needLayout(label) {
    var note = uxdEnableAutoLayout(node, null);
    if (note) notes.push(note + " so " + label + " could be applied");
  }
  switch (key) {
    case "fill":
      need("fills", "fill");
      if (node.type === "TEXT") await uxdLoadTextFonts(node);
      node.fills = [uxdSolid(value)]; return;
    case "fillNone": need("fills", "fill"); node.fills = []; return;
    case "gradient": {
      need("fills", "fill");
      var a = uxdHexToRgb(value[0]), b = uxdHexToRgb(value[1]);
      node.fills = [{ type: "GRADIENT_LINEAR", gradientTransform: [[1, 0, 0], [0, 1, 0]], visible: true, opacity: 1,
        gradientStops: [{ position: 0, color: { r: a.r, g: a.g, b: a.b, a: a.a } }, { position: 1, color: { r: b.r, g: b.g, b: b.b, a: b.a } }] }];
      return;
    }
    case "colorShift": {
      need("fills", "fill");
      var fills = Array.isArray(node.fills) ? node.fills : [];
      var solid = fills.filter(function (p) { return p.type === "SOLID" && p.visible !== false; }).pop();
      if (!solid) throw new Error("\"" + node.name + "\" has no solid colour to make " + (value > 0 ? "lighter" : "darker") + ".");
      if (node.type === "TEXT") await uxdLoadTextFonts(node);
      node.fills = fills.map(function (p) { return p === solid ? Object.assign({}, p, { color: uxdShiftColor(p.color, value) }) : p; });
      return;
    }
    case "stroke": {
      need("strokes", "border");
      var current = Array.isArray(node.strokes) ? node.strokes.filter(function (p) { return p.type === "SOLID"; })[0] : null;
      if (value.color) node.strokes = [uxdSolid(value.color)];
      else if (!current) node.strokes = [uxdSolid("#D0D5DD")];
      if (Number.isFinite(value.weight)) node.strokeWeight = Math.max(0, Math.min(100, value.weight));
      else if (!current && !(node.strokeWeight > 0)) node.strokeWeight = 1;
      if (value.dash && "dashPattern" in node) node.dashPattern = value.dash === "dashed" ? [6, 4] : value.dash === "dotted" ? [2, 2] : [];
      return;
    }
    case "strokeNone": need("strokes", "border"); node.strokes = []; return;
    case "strokeWeightDelta": need("strokes", "border"); node.strokeWeight = Math.max(0, (Number(node.strokeWeight) || 0) + value); return;
    case "radius": need("cornerRadius", "corner radius"); node.cornerRadius = Math.max(0, value); return;
    case "radiusPill": need("cornerRadius", "corner radius"); node.cornerRadius = Math.round(Math.min(node.width, node.height) / 2); return;
    case "radiusDelta": {
      need("cornerRadius", "corner radius");
      var r = typeof node.cornerRadius === "number" ? node.cornerRadius : Number(node.topLeftRadius) || 0;
      node.cornerRadius = Math.max(0, r + value); return;
    }
    case "opacity": need("opacity", "opacity"); node.opacity = Math.max(0, Math.min(1, value)); return;
    case "shadow": {
      need("effects", "effects");
      var preset = UXD_SHADOWS[value] || UXD_SHADOWS.soft;
      var keep = (node.effects || []).filter(function (e) { return e.type !== preset.type; });
      var shadow = { type: preset.type, visible: true, blendMode: "NORMAL", color: { r: 0.06, g: 0.09, b: 0.16, a: preset.a },
        offset: { x: 0, y: preset.y }, radius: preset.blur, spread: 0 };
      if (preset.type === "DROP_SHADOW") shadow.showShadowBehindNode = false;
      uxdSetEffects(node, keep.concat([shadow])); return;
    }
    case "shadowNone": need("effects", "effects"); uxdSetEffects(node, (node.effects || []).filter(function (e) { return !/SHADOW/.test(e.type); })); return;
    case "blur": {
      need("effects", "effects");
      var others = (node.effects || []).filter(function (e) { return e.type !== value.type; });
      uxdSetEffects(node, others.concat([{ type: value.type, visible: true, radius: value.radius, blurType: "NORMAL" }])); return;
    }
    case "blurNone": need("effects", "effects"); uxdSetEffects(node, (node.effects || []).filter(function (e) { return !/BLUR/.test(e.type); })); return;
    case "effectsNone": need("effects", "effects"); uxdSetEffects(node, []); return;
    case "padding":
      need("layoutMode", "padding"); needLayout("padding");
      ["Top", "Right", "Bottom", "Left"].forEach(function (side) {
        var v = value[side.toLowerCase()];
        if (Number.isFinite(v)) node["padding" + side] = Math.max(0, v);
      });
      return;
    case "paddingDelta":
      need("layoutMode", "padding"); needLayout("padding");
      ["Top", "Right", "Bottom", "Left"].forEach(function (side) { node["padding" + side] = Math.max(0, (Number(node["padding" + side]) || 0) + value); });
      return;
    case "gap": need("layoutMode", "spacing"); needLayout("spacing"); node.itemSpacing = Math.max(0, value); return;
    case "gapDelta": need("layoutMode", "spacing"); needLayout("spacing"); node.itemSpacing = Math.max(0, (Number(node.itemSpacing) || 0) + value); return;
    case "layout": {
      if (value === "AUTO") {
        var note = uxdEnableAutoLayout(node, null);
        if (!note) notes.push("\"" + node.name + "\" already uses auto layout");
        return;
      }
      need("layoutMode", "auto layout");
      if (!uxdHasAutoLayout(node)) uxdEnableAutoLayout(node, value);
      else node.layoutMode = value;
      return;
    }
    case "layoutNone": need("layoutMode", "auto layout"); node.layoutMode = "NONE"; return;
    case "layoutWrap": need("layoutMode", "auto layout"); needLayout("wrap"); node.layoutMode = "HORIZONTAL"; node.layoutWrap = value ? "WRAP" : "NO_WRAP"; return;
    case "align": {
      var v = value.value;
      if (node.type === "TEXT") {
        if (v === "top" || v === "bottom" || v === "middle") { node.textAlignVertical = v === "middle" ? "CENTER" : v.toUpperCase(); return; }
        await uxdLoadTextFonts(node);
        node.textAlignHorizontal = v === "justify" ? "JUSTIFIED" : v === "center" ? "CENTER" : v.toUpperCase();
        return;
      }
      if (uxdHasAutoLayout(node)) {
        var mode = node.layoutMode;
        var map = { left: "MIN", top: "MIN", center: "CENTER", middle: "CENTER", right: "MAX", bottom: "MAX" };
        if (v === "space-between") { node.primaryAxisAlignItems = "SPACE_BETWEEN"; return; }
        var horizontalValue = ["left", "right"].indexOf(v) >= 0 || (v === "center" && value.axis !== "v");
        var verticalValue = ["top", "bottom", "middle"].indexOf(v) >= 0 || (v === "center" && value.axis !== "h");
        if (horizontalValue) { if (mode === "HORIZONTAL") node.primaryAxisAlignItems = map[v]; else node.counterAxisAlignItems = map[v]; }
        if (verticalValue) { if (mode === "VERTICAL") node.primaryAxisAlignItems = map[v]; else node.counterAxisAlignItems = map[v]; }
        return;
      }
      var parent = node.parent;
      if (!parent || parent.type === "PAGE" || typeof parent.width !== "number") throw new Error("\"" + node.name + "\" has no parent frame to align inside.");
      if (uxdHasAutoLayout(parent) && node.layoutPositioning !== "ABSOLUTE") throw new Error("\"" + node.name + "\" sits in auto layout; select its parent \"" + parent.name + "\" and ask to align items instead.");
      if (v === "left") node.x = 0; else if (v === "right") node.x = parent.width - node.width;
      else if (v === "top") node.y = 0; else if (v === "bottom") node.y = parent.height - node.height;
      else {
        if (value.axis !== "v") node.x = Math.round((parent.width - node.width) / 2);
        if (value.axis !== "h") node.y = Math.round((parent.height - node.height) / 2);
      }
      return;
    }
    case "width": case "height": case "scale": {
      if (typeof node.resize !== "function") throw new Error("\"" + node.name + "\" cannot be resized.");
      var w = key === "width" ? value : key === "scale" ? node.width * value : node.width;
      var h = key === "height" ? value : key === "scale" ? node.height * value : node.height;
      if (node.type === "TEXT") { await uxdLoadTextFonts(node); if (key !== "scale") node.textAutoResize = key === "width" ? "HEIGHT" : "NONE"; }
      node.resize(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
      return;
    }
    case "sizingH": case "sizingV": {
      var prop = key === "sizingH" ? "layoutSizingHorizontal" : "layoutSizingVertical";
      if (!(prop in node)) throw new Error("\"" + node.name + "\" does not support " + (value === "FILL" ? "fill container" : value.toLowerCase()) + ".");
      if (value === "FILL" && !uxdHasAutoLayout(node.parent)) {
        if (key === "sizingH" && node.parent && typeof node.parent.width === "number" && typeof node.resize === "function") {
          node.x = 0; node.resize(node.parent.width, node.height); return;
        }
        throw new Error("Fill container needs \"" + node.name + "\" to sit inside an auto layout frame.");
      }
      if (value === "HUG" && !uxdHasAutoLayout(node) && node.type !== "TEXT") throw new Error("Hug contents needs auto layout on \"" + node.name + "\". Say \"add auto layout\" first.");
      if (node.type === "TEXT") await uxdLoadTextFonts(node);
      node[prop] = value; return;
    }
    case "move": {
      if (uxdHasAutoLayout(node.parent) && node.layoutPositioning !== "ABSOLUTE") throw new Error("\"" + node.name + "\" is placed by auto layout, so it cannot be moved freely. Change the order or spacing instead.");
      node.x += value.dx || 0; node.y += value.dy || 0; return;
    }
    case "rotate": need("rotation", "rotation"); node.rotation = ((Number(node.rotation) || 0) + value) % 360; return;
    case "flip": {
      need("relativeTransform", "transform");
      var t = node.relativeTransform;
      var cx = node.width, cy = node.height;
      node.relativeTransform = value === "h"
        ? [[-t[0][0], t[0][1], t[0][2] + t[0][0] * cx], [-t[1][0], t[1][1], t[1][2] + t[1][0] * cx]]
        : [[t[0][0], -t[0][1], t[0][2] + t[0][1] * cy], [t[1][0], -t[1][1], t[1][2] + t[1][1] * cy]];
      return;
    }
    case "clip": need("clipsContent", "clip content"); node.clipsContent = value; return;
    case "visible": node.visible = value; return;
    case "showHidden": {
      var hidden = uxdDescendants(node, function (c) { return c.visible === false; });
      hidden.forEach(function (c) { c.visible = true; });
      if (node.visible === false) node.visible = true;
      notes.push("showed " + hidden.length + " hidden layer(s) in \"" + node.name + "\"");
      return;
    }
    case "locked": node.locked = value; return;
    case "name": node.name = String(value).slice(0, 120); return;
    case "text": needText(); await uxdLoadTextFonts(node); node.characters = String(value); return;
    case "replace": {
      needText();
      var from = String(value.from);
      if (node.characters.toLowerCase().indexOf(from.toLowerCase()) < 0) throw new Error("\"" + from + "\" is not in \"" + node.name + "\".");
      await uxdLoadTextFonts(node);
      var source = node.characters, out = "", index = 0, lower = source.toLowerCase(), needle = from.toLowerCase();
      while (true) {
        var at = lower.indexOf(needle, index);
        if (at < 0) { out += source.slice(index); break; }
        out += source.slice(index, at) + value.to; index = at + from.length;
      }
      node.characters = out; return;
    }
    case "fontSize": needText(); await uxdLoadTextFonts(node); uxdSetFontSize(node, function () { return value; }); return;
    case "fontSizeDelta": needText(); await uxdLoadTextFonts(node); uxdSetFontSize(node, function (s) { return s + value; }); return;
    case "fontWeight": case "italic": {
      needText(); await uxdLoadTextFonts(node);
      var failed = "";
      await uxdSetFonts(node, async function (current) {
        var italicNow = /italic|oblique/i.test(current.style);
        var weight = key === "fontWeight" ? value : uxdWeightOf(current.style);
        var italic = key === "italic" ? value : italicNow;
        var font = await uxdTryFont(current.family, uxdStyleCandidates(weight, italic));
        if (!font) failed = current.family;
        return font;
      });
      if (failed) throw new Error(failed + " has no " + (key === "italic" ? "italic" : value) + " style in this file.");
      return;
    }
    case "fontFamily": {
      needText(); await uxdLoadTextFonts(node);
      var list = await uxdFontList();
      if (list.size && !list.get(String(value).toLowerCase())) throw new Error("The font \"" + value + "\" is not available in this Figma file.");
      var missing = false;
      await uxdSetFonts(node, async function (current) {
        var weight = uxdWeightOf(current.style);
        var italic = /italic|oblique/i.test(current.style);
        var font = await uxdTryFont(value, [current.style].concat(uxdStyleCandidates(weight, italic), ["Regular"]));
        if (!font) missing = true;
        return font;
      });
      if (missing) throw new Error("The font \"" + value + "\" could not be loaded.");
      return;
    }
    case "decoration": needText(); await uxdLoadTextFonts(node); node.textDecoration = value; return;
    case "textCase": {
      needText(); await uxdLoadTextFonts(node);
      if (value === "SENTENCE") {
        node.textCase = "ORIGINAL";
        node.characters = node.characters.toLowerCase().replace(/(^\s*|[.!?]\s+)([a-z])/g, function (m, p, l) { return p + l.toUpperCase(); });
      } else node.textCase = value;
      return;
    }
    case "lineHeight": needText(); await uxdLoadTextFonts(node); node.lineHeight = value === "auto" ? { unit: "AUTO" } : value; return;
    case "letterSpacing": needText(); await uxdLoadTextFonts(node); node.letterSpacing = value; return;
    case "textAutoResize": needText(); await uxdLoadTextFonts(node); node.textAutoResize = value; return;
    case "truncate": needText(); await uxdLoadTextFonts(node); node.textTruncation = value ? "ENDING" : "DISABLED"; return;
  }
  throw new Error("Unknown direct edit " + key + ".");
}
async function uxdRunStructural(action, nodes, op, notes) {
  var ids = nodes.map(function (n) { return n.id; });
  async function write(payload) { return writeCanvasCommand(Object.assign({ confirm: true }, payload), { local: true }); }
  if (action === "duplicate") {
    var times = Math.max(1, Math.min(10, op.count || 1));
    for (var i = 0; i < nodes.length; i++) for (var t = 0; t < times; t++) await write({ operation: "clone-node", nodeId: nodes[i].id });
    return nodes.length * times + " cop" + (nodes.length * times === 1 ? "y" : "ies") + " created";
  }
  if (action === "delete") { for (var d = 0; d < nodes.length; d++) await write({ operation: "delete-node", nodeId: nodes[d].id }); return nodes.length + " layer(s) deleted"; }
  if (action === "deleteHidden") {
    var removed = 0;
    nodes.forEach(function (n) { uxdDescendants(n, function (c) { return c.visible === false; }).forEach(function (c) { if (!c.removed) { c.remove(); removed++; } }); });
    return removed + " hidden layer(s) deleted";
  }
  if (action === "group") { await write({ operation: "group-nodes", nodeIds: ids }); return "grouped " + ids.length + " layers"; }
  if (action === "ungroup") {
    var groups = nodes.filter(function (n) { return n.type === "GROUP"; });
    if (!groups.length) throw new Error("The selection has no group to ungroup.");
    for (var g = 0; g < groups.length; g++) await write({ operation: "ungroup-node", nodeId: groups[g].id });
    return groups.length + " group(s) ungrouped";
  }
  if (action === "component") { for (var c = 0; c < nodes.length; c++) await write({ operation: "create-component", nodeId: nodes[c].id }); return nodes.length + " component(s) created"; }
  if (action === "detach") {
    var instances = nodes.filter(function (n) { return n.type === "INSTANCE"; });
    if (!instances.length) throw new Error("The selection has no component instance to detach.");
    for (var k = 0; k < instances.length; k++) await write({ operation: "detach-instance", nodeId: instances[k].id });
    return instances.length + " instance(s) detached";
  }
  if (action === "flatten") { await write({ operation: "flatten-nodes", nodeIds: ids }); return "flattened"; }
  if (action === "front" || action === "back") {
    for (var f = 0; f < nodes.length; f++) {
      var parent = nodes[f].parent;
      await write({ operation: "reorder-node", nodeId: nodes[f].id, index: action === "front" ? parent.children.length - 1 : 0 });
    }
    return action === "front" ? "brought to front" : "sent to back";
  }
  if (action === "wrap") {
    var horizontal = op.direction === "HORIZONTAL";
    if (!op.direction && nodes.length > 1) {
      var xs = nodes.slice().sort(function (a, b) { return a.x - b.x; });
      horizontal = xs.every(function (n, i) { return i === 0 || n.x >= xs[i - 1].x + xs[i - 1].width - 1; });
    }
    await write({ operation: "wrap-in-auto-layout", nodeIds: ids, autoLayout: { layoutMode: horizontal ? "HORIZONTAL" : "VERTICAL" } });
    return "wrapped in " + (horizontal ? "a horizontal" : "a vertical") + " auto layout frame";
  }
  if (action === "variant") return uxdSwitchVariant(nodes, String(op.value || ""));
  if (action === "insertComponent") return uxdInsertComponent(nodes, op);
  throw new Error("Unknown action " + action + ".");
}
var UXD_VARIANT_SYNONYMS = {
  enabled: ["enabled", "default", "normal", "rest", "idle"], default: ["default", "enabled", "normal", "rest"],
  active: ["active", "selected", "on", "current"], inactive: ["inactive", "default", "off", "unselected"],
  selected: ["selected", "active", "on", "checked"], unselected: ["unselected", "default", "inactive", "off"],
  checked: ["checked", "on", "selected"], unchecked: ["unchecked", "off", "default", "unselected"],
  hover: ["hover", "hovered"], hovered: ["hovered", "hover"], pressed: ["pressed", "active", "down"],
  focused: ["focused", "focus"], disabled: ["disabled", "inactive"], loading: ["loading", "busy"], error: ["error", "invalid", "danger"]
};
var UXD_NEGATIVE_STATES = { enabled: true, default: true, inactive: true, unselected: true, unchecked: true };
// Picks a variant option for a state word, or a boolean variant named after it ("Disabled=true").
function uxdPickVariantOption(defs, value) {
  var wanted = UXD_VARIANT_SYNONYMS[value] || [value];
  var keys = Object.keys(defs || {}).filter(function (k) { return defs[k] && defs[k].type === "VARIANT"; });
  for (var w = 0; w < wanted.length; w++) {
    for (var i = 0; i < keys.length; i++) {
      var options = defs[keys[i]].variantOptions || [];
      for (var o = 0; o < options.length; o++) if (String(options[o]).trim().toLowerCase() === wanted[w]) return { prop: keys[i], option: options[o] };
    }
  }
  var base = UXD_NEGATIVE_STATES[value] ? null : value;
  var boolKey = keys.find(function (k) { return String(k).trim().toLowerCase() === (base || ""); });
  if (boolKey) {
    var yes = (defs[boolKey].variantOptions || []).find(function (o) { return /^(true|yes|on)$/i.test(String(o)); });
    if (yes) return { prop: boolKey, option: yes };
  }
  return null;
}
async function uxdSwitchVariant(nodes, value) {
  var instances = [];
  nodes.forEach(function (n) {
    if (n.type === "INSTANCE") { if (instances.indexOf(n) < 0) instances.push(n); return; }
    if ("findAllWithCriteria" in n) n.findAllWithCriteria({ types: ["INSTANCE"] }).forEach(function (i) { if (instances.indexOf(i) < 0 && !(i.parent && i.parent.type === "INSTANCE")) instances.push(i); });
  });
  if (!instances.length) throw new Error("Select a component instance to change its state.");
  var changed = 0, missing = [];
  for (var i = 0; i < instances.length; i++) {
    var main = await instances[i].getMainComponentAsync();
    var set = main && main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : null;
    var pick = set ? uxdPickVariantOption(set.componentPropertyDefinitions, value) : null;
    if (!pick) { missing.push(instances[i].name); continue; }
    var props = {}; props[pick.prop] = pick.option;
    instances[i].setProperties(props);
    changed++;
  }
  if (!changed) throw new Error("\"" + missing[0] + "\" has no \"" + value + "\" variant. Add that variant to its component set first.");
  return changed + " instance(s) set to " + value + (missing.length ? " (" + missing.length + " had no " + value + " variant)" : "");
}
function uxdComponentScore(name, kind, qualifiers) {
  var lower = String(name || "").toLowerCase();
  var kindPattern = kind === "textfield" ? /text ?field|input|field/ : kind === "searchbar" ? /search/ : new RegExp("\\b" + kind + "s?\\b");
  if (!kindPattern.test(lower)) return -1;
  var score = 1;
  qualifiers.forEach(function (q) { if (lower.indexOf(q) >= 0) score += 3; });
  if (/disabled|hover|pressed|focus|error|loading/.test(lower)) score -= 2;
  return score;
}
function uxdBestVariant(component, qualifiers) {
  if (component.type !== "COMPONENT_SET") return component;
  var best = component.defaultVariant || component.children[0], bestScore = -1;
  component.children.forEach(function (child) {
    if (child.type !== "COMPONENT") return;
    var score = 0, lower = String(child.name || "").toLowerCase();
    qualifiers.forEach(function (q) { if (lower.indexOf(q) >= 0) score += 3; });
    if (/disabled|hover|pressed|focus|error|loading/.test(lower)) score -= 2;
    if (child === component.defaultVariant) score += 1;
    if (score > bestScore) { best = child; bestScore = score; }
  });
  return best;
}
// Finds the file's own component for "add a primary button": first ones the selected screen already uses,
// then components on this page. Never invents a component.
async function uxdFindComponent(roots, kind, qualifiers) {
  var candidates = [];
  function consider(node, bonus) {
    if (!node || node.removed) return;
    var target = node.type === "COMPONENT" && node.parent && node.parent.type === "COMPONENT_SET" ? node.parent : node;
    var score = uxdComponentScore(target.name + (target !== node ? " " + node.name : ""), kind, qualifiers);
    if (score >= 0) candidates.push({ component: target, score: score + bonus, variant: target !== node ? node : null });
  }
  for (var r = 0; r < roots.length; r++) {
    var used = "findAllWithCriteria" in roots[r] ? roots[r].findAllWithCriteria({ types: ["INSTANCE"] }) : [];
    for (var u = 0; u < used.length && u < 200; u++) {
      if (used[u].parent && used[u].parent.type === "INSTANCE") continue;
      consider(await used[u].getMainComponentAsync(), 2);
    }
  }
  if (!candidates.length) figma.currentPage.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] }).forEach(function (c) {
    if (c.type === "COMPONENT" && c.parent && c.parent.type === "COMPONENT_SET") return;
    consider(c, 0);
  });
  if (!candidates.length) return null;
  candidates.sort(function (a, b) { return b.score - a.score; });
  var top = candidates[0];
  return top.variant && !qualifiers.length ? top.variant : uxdBestVariant(top.component, qualifiers);
}
// The left inset of content inside full-width sections of a screen: the most common x of their inner layers.
function uxdContentInset(parent, except) {
  var counts = {};
  parent.children.forEach(function (section) {
    if (section === except || section.visible === false || !section.children || section.width < parent.width - 1) return;
    section.children.forEach(function (c) {
      if (c.visible === false || c.x <= 0 || c.width >= section.width - 1) return;
      counts[Math.round(c.x)] = (counts[Math.round(c.x)] || 0) + 1;
    });
  });
  var best = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a - b; })[0];
  return best !== undefined && Number(best) <= 48 ? Number(best) : 0;
}
// Existing layers in the selection that already are the asked thing ("Loan Card" for "loan card"):
// layer name, or its main component's name, has the kind and every qualifier.
async function uxdExistingMatches(root, kind, qualifiers) {
  if (!root || !("findAll" in root)) return [];
  var words = [kind.replace(/field$/, " field")].concat(qualifiers).map(function (w) { return w.replace(/\s+/g, "").toLowerCase(); });
  function fits(name) {
    var flat = String(name || "").toLowerCase().replace(/[\s_\-\/]+/g, "");
    return words.every(function (w) { return flat.indexOf(w) >= 0; });
  }
  var found = [];
  var all = root.findAll(function (n) { return n.visible !== false && n.type !== "TEXT" && n.type !== "VECTOR"; });
  for (var i = 0; i < all.length && i < 2000; i++) {
    var n = all[i];
    // Inside another match (or an instance) it is part of that thing, not a sibling.
    var inside = false;
    for (var p = n.parent; p && p !== root; p = p.parent) { if (p.type === "INSTANCE" || found.indexOf(p) >= 0) { inside = true; break; } }
    if (inside) continue;
    var name = n.name;
    if (!fits(name) && n.type === "INSTANCE") {
      try { var main = await n.getMainComponentAsync(); if (main) name = (main.parent && main.parent.type === "COMPONENT_SET" ? main.parent.name : main.name); } catch (_) {}
    }
    if (fits(name)) found.push(n);
  }
  return found;
}
// A fixed-height screen clips what an insert pushes past its bottom ("add another loan card" ended at
// 907px inside an 800px frame; tester T9): the screen grows to fit, and Revert restores its height.
function uxdGrowScreenToFit(node) {
  var screen = node;
  while (screen && screen.parent && screen.parent.type !== "PAGE") screen = screen.parent;
  if (!screen || screen === node || typeof screen.resize !== "function" || !node.absoluteBoundingBox || !screen.absoluteBoundingBox) return 0;
  if (screen.layoutMode && screen.layoutMode !== "NONE" && screen.layoutMode !== "GRID") {
    var vertical = screen.layoutMode === "VERTICAL";
    if ((vertical ? screen.primaryAxisSizingMode : screen.counterAxisSizingMode) === "AUTO") return 0;
  }
  var box = node.absoluteBoundingBox;
  var pad = typeof screen.paddingBottom === "number" && screen.paddingBottom > 0 ? screen.paddingBottom : 16;
  var need = Math.ceil(box.y + box.height + pad - screen.absoluteBoundingBox.y);
  if (need <= screen.height + 0.5) return 0;
  uxdSnapProp(screen, "height");
  screen.resize(screen.width, need);
  return need;
}
async function uxdInsertComponent(roots, op) {
  var kind = String(op.component || "button");
  var qualifiers = (Array.isArray(op.qualifiers) ? op.qualifiers : []).map(String).filter(function (q) { return q.length > 1; });
  var root = roots[0];
  // "add another loan card" (or a list that already repeats it): duplicate the last one in its own list,
  // so it lands beside its siblings instead of in a new wrapper at the screen root.
  var existing = await uxdExistingMatches(root, kind, qualifiers);
  if (existing.length && (op.another === true || existing.length >= 2)) {
    var byParent = new Map();
    existing.forEach(function (n) { byParent.set(n.parent, (byParent.get(n.parent) || []).concat([n])); });
    var group = Array.from(byParent.values()).sort(function (a, b) { return b.length - a.length; })[0];
    var last = group.slice().sort(function (a, b) { return a.parent.children.indexOf(a) - b.parent.children.indexOf(b); })[group.length - 1];
    var copy = last.clone();
    var host = last.parent;
    host.insertChild(host.children.indexOf(last) + 1, copy);
    if (!("layoutMode" in host) || host.layoutMode === "NONE") { copy.x = last.x; copy.y = last.y + last.height + 12; }
    figma.currentPage.selection = [copy];
    var grownTo = uxdGrowScreenToFit(copy);
    return "added another \"" + last.name + "\" after the last one" + (grownTo ? " and grew the screen to " + grownTo + "px so it is not cut off" : "");
  }
  var parent = root.type === "INSTANCE" || !("appendChild" in root) ? root.parent : root;
  var component = await uxdFindComponent(roots, kind, qualifiers);
  if (!component) throw new Error("No " + kind + " component found in this screen or on this page. Create or import one, then try again.");
  var instance = component.createInstance();
  if (parent === root.parent && parent && "insertChild" in parent) {
    parent.insertChild(parent.children.indexOf(root) + 1, instance);
    if (!("layoutMode" in parent) || parent.layoutMode === "NONE") { instance.x = root.x; instance.y = root.y + root.height + 16; }
  } else {
    parent.appendChild(instance);
    var mobile = typeof parent.width === "number" && parent.width <= 480;
    if (!("layoutMode" in parent) || parent.layoutMode === "NONE") {
      var kids = parent.children.filter(function (c) { return c !== instance && c.visible !== false; });
      // A full-bleed background is not content; the button goes below the lowest real layer.
      var content = kids.filter(function (c) { return !(c.width >= parent.width - 1 && c.height >= parent.height - 1); });
      var bottom = content.reduce(function (m, c) { return Math.max(m, c.y + c.height); }, 0);
      // The screen's gutter: the most common left edge among content that does not span the full width
      // (backgrounds and headers sit at x=0).
      var counts = {};
      kids.forEach(function (c) { if (c.x > 0 && c.width < parent.width - 1) counts[Math.round(c.x)] = (counts[Math.round(c.x)] || 0) + 1; });
      var gutter = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a - b; })[0];
      var left = gutter !== undefined ? Number(gutter) : 16;
      instance.x = left; instance.y = bottom + 16;
      if (mobile && typeof instance.resize === "function" && parent.width - 2 * left > instance.width) instance.resize(parent.width - 2 * left, instance.height);
    } else if (mobile && parent.layoutMode === "VERTICAL") {
      // A screen with no side padding keeps its gutter inside full-width section frames (cards at x=20).
      // Put the button in a transparent row with that inset, so it lines up instead of running edge to edge.
      var inset = (parent.paddingLeft || 0) > 0 ? 0 : uxdContentInset(parent, instance);
      if (inset > 0 && typeof figma.createFrame === "function") {
        var row = figma.createFrame();
        row.name = "Button row";
        row.fills = [];
        row.clipsContent = false;
        row.layoutMode = "VERTICAL";
        row.paddingLeft = inset; row.paddingRight = inset; row.paddingTop = 0; row.paddingBottom = 0;
        parent.insertChild(parent.children.indexOf(instance), row);
        row.appendChild(instance);
        row.layoutSizingHorizontal = "FILL";
        row.layoutSizingVertical = "HUG";
      }
      instance.layoutSizingHorizontal = "FILL";
    }
  }
  figma.currentPage.selection = [instance];
  var grown = uxdGrowScreenToFit(instance);
  return "placed \"" + (component.parent && component.parent.type === "COMPONENT_SET" ? component.parent.name + " / " + component.name : component.name) + "\" from your components" +
    (grown ? " and grew the screen to " + grown + "px so it is not cut off" : "");
}
async function localApplyDirectEdits(payload) {
  var ops = Array.isArray(payload.ops) ? payload.ops.slice(0, 30) : [];
  if (!ops.length) throw new Error("No edits to apply.");
  var roots = figma.currentPage.selection.slice();
  if (!roots.length) throw new Error("Select the layer you want to change first.");
  // Resolve every target before changing anything, so an unknown target hands over to the model untouched.
  var plan = [];
  for (var i = 0; i < ops.length; i++) {
    var resolved = uxdResolveTargets(roots, ops[i]);
    if (resolved.needsModel) return { ok: false, needsModel: true, reason: resolved.reason };
    if (resolved.error) throw new Error(resolved.error);
    plan.push({ op: ops[i], nodes: resolved.nodes });
  }
  await uxdPrewarmDirectEditFonts(plan);
  if (typeof figma.commitUndo === "function") figma.commitUndo();
  var applied = [], notes = [], errors = [];
  // Snapshot every property a set-op can touch, so Revert restores exactly these values later,
  // whatever happened on the canvas since (Figma undo would pop the wrong step).
  UXD_HYGIENE_SNAPSHOT = { keys: {}, items: [] };
  var structural = false;
  plan.forEach(function (step) {
    if (step.op.action) { structural = true; return; }
    step.nodes.forEach(function (node) { UXD_DIRECT_SNAP_PROPS.forEach(function (prop) { if (prop in node) uxdSnapProp(node, prop); }); });
  });
  for (var p = 0; p < plan.length; p++) {
    var step = plan[p];
    if (step.op.action) {
      try { applied.push({ label: step.op.label || step.op.action, count: step.nodes.length, note: await uxdRunStructural(step.op.action, step.nodes, step.op, notes) }); }
      catch (error) { errors.push((step.op.label || step.op.action) + ": " + (error && error.message ? error.message : String(error))); }
      continue;
    }
    var done = 0;
    for (var n = 0; n < step.nodes.length; n++) {
      try { await uxdApplySet(step.nodes[n], step.op.set, notes); done++; }
      catch (error) {
        var message = error && error.message ? error.message : String(error);
        if (errors.indexOf(message) < 0) errors.push(message);
      }
    }
    if (done) applied.push({ label: step.op.label || Object.keys(step.op.set)[0], count: done });
  }
  if (typeof figma.commitUndo === "function") figma.commitUndo();
  var snapshot = UXD_HYGIENE_SNAPSHOT.items.map(function (item) {
    var after = uxdCloneValue(item.node[item.prop]);
    return { id: item.node.id, prop: item.prop, before: item.before, after: after === undefined ? null : after };
  }).filter(function (item) { return JSON.stringify(item.before) !== JSON.stringify(item.after); });
  UXD_HYGIENE_SNAPSHOT = null;
  var layoutChanged = structural || snapshot.some(function (item) { return item.prop === "layoutMode" || item.prop === "layoutWrap"; });
  if (!applied.length) throw new Error(errors.slice(0, 3).join(" ") || "Nothing could be changed.");
  return { ok: true, applied: applied, notes: notes.slice(0, 6), errors: errors.slice(0, 6), snapshot: snapshot, layoutChanged: layoutChanged };
}
var UXD_DIRECT_SNAP_PROPS = ["fills", "strokes", "strokeWeight", "dashPattern", "cornerRadius", "opacity", "effects",
  "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "itemSpacing", "layoutMode", "layoutWrap",
  "primaryAxisAlignItems", "counterAxisAlignItems", "textAlignHorizontal", "textAlignVertical", "fontSize", "fontName",
  "textCase", "textDecoration", "letterSpacing", "lineHeight", "x", "y",
  // Copy, renames and visibility are direct edits too: without them Revert restored "0 values" after
  // a find/replace or rename (characters must be restored last, so it sits after the font props).
  "name", "visible", "characters"];
// uxd-hygiene-fix:start
// One-click hygiene fixer. Deterministic, no model: every change is computed from live layer properties,
// so the same selection always gets the same fix. Groups: "spacing" (4px grid + near-symmetric padding),
// "tokens" (bind hard-coded colours / text to the file's exactly matching variable or style, so nothing
// changes visually), "a11y" (WCAG contrast, 12px minimum text, 44px touch targets on auto-layout frames),
// "layout" (auto layout on cleanly stacked frames). Instances, locked and hidden layers are never touched.
var UXD_HYGIENE_GROUPS = ["spacing", "tokens", "a11y", "layout", "names"];
var UXD_HYGIENE_INTERACTIVE = /\b(button|btn|cta|icon[ -]?button|tab|chip|toggle|switch|checkbox|radio|link|close|back|menu|fab)\b/i;
// includeInstanceChildren: text inside instances (button labels, card values) is where most contrast and
// small-text findings live; those get instance overrides. Structure and tokens stay with the main component.
function uxdHygieneNodes(roots, includeInstanceChildren) {
  var out = [];
  (function walk(list, inside) {
    for (var i = 0; i < list.length; i++) {
      var node = list[i];
      if (!node || node.removed || node.visible === false || node.locked === true) continue;
      if (!inside || includeInstanceChildren) out.push(node);
      if (Array.isArray(node.children) && (node.type !== "INSTANCE" || includeInstanceChildren)) walk(node.children, inside || node.type === "INSTANCE");
    }
  })(roots, false);
  return out;
}
function uxdSnapToGrid(value) {
  if (typeof value !== "number" || !isFinite(value) || value <= 0 || value === 2) return value;
  // A file's own spacing scale (design rules) wins over the generic 4px grid.
  var scale = UXD_ACTIVE_RULES && Array.isArray(UXD_ACTIVE_RULES.spacing) && UXD_ACTIVE_RULES.spacing.length ? UXD_ACTIVE_RULES.spacing : null;
  if (scale) return uxdNearest(scale, value);
  if (value < 3) return 2;
  return Math.round(value / 4) * 4;
}
function uxdBound(node, prop) {
  try { return !!(node.boundVariables && node.boundVariables[prop]); } catch (_) { return false; }
}
function uxdColorKey(color, alpha) {
  function h(v) { return Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0"); }
  return (h(color.r) + h(color.g) + h(color.b)).toUpperCase() + "/" + Math.round((alpha === undefined ? 1 : alpha) * 100);
}
function uxdLuminance(c) {
  function ch(v) { return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}
function uxdContrast(a, b) {
  var la = uxdLuminance(a), lb = uxdLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function uxdSingleSolid(paints) {
  if (!Array.isArray(paints)) return null;
  var visible = paints.filter(function (p) { return p && p.visible !== false; });
  return visible.length === 1 && visible[0].type === "SOLID" && paints.length === 1 ? visible[0] : null;
}
async function uxdHygienePalette() {
  var palette = { styles: new Map(), variables: new Map(), usedVariables: new Map() };
  try {
    var styles = await figma.getLocalPaintStylesAsync();
    styles.forEach(function (style) {
      var paint = uxdSingleSolid(style.paints);
      if (!paint) return;
      var key = uxdColorKey(paint.color, paint.opacity);
      palette.styles.set(key, (palette.styles.get(key) || []).concat([style]));
    });
  } catch (_) {}
  try {
    if (figma.variables && typeof figma.variables.getLocalVariablesAsync === "function") {
      var vars = await figma.variables.getLocalVariablesAsync("COLOR");
      var collections = new Map();
      for (var i = 0; i < vars.length; i++) {
        var variable = vars[i];
        if (!variable || variable.resolvedType !== "COLOR") continue;
        var collection = collections.get(variable.variableCollectionId);
        if (collection === undefined) {
          try { collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId); } catch (_) { collection = null; }
          collections.set(variable.variableCollectionId, collection);
        }
        var value = variable.valuesByMode ? variable.valuesByMode[collection && collection.defaultModeId ? collection.defaultModeId : Object.keys(variable.valuesByMode)[0]] : null;
        for (var hop = 0; hop < 3 && value && value.type === "VARIABLE_ALIAS"; hop++) {
          var target = await figma.variables.getVariableByIdAsync(value.id).catch(function () { return null; });
          if (!target || !target.valuesByMode) { value = null; break; }
          var targetCollection = await figma.variables.getVariableCollectionByIdAsync(target.variableCollectionId).catch(function () { return null; });
          value = target.valuesByMode[targetCollection && targetCollection.defaultModeId ? targetCollection.defaultModeId : Object.keys(target.valuesByMode)[0]];
        }
        if (!value || typeof value.r !== "number") continue;
        var key = uxdColorKey(value, value.a);
        palette.variables.set(key, (palette.variables.get(key) || []).concat([variable]));
      }
    }
  } catch (_) {}
  // Colour variables the file's own screens already use (often library variables, which are not
  // local): keyed by the colour they render on this page, so a new card in #383838 binds to the
  // same variable as the source card (benchmark: the source binds fills to variables, not styles).
  try {
    if (figma.variables && typeof figma.variables.getVariableByIdAsync === "function") {
      var seenIds = {};
      var stack = figma.currentPage.children.slice(), visited = 0;
      while (stack.length && visited < 20000) {
        var n = stack.pop();
        visited++;
        if (!n || n.removed) continue;
        if (n.getPluginData && n.getPluginData("uxdCreated") === "1") continue;
        if ("fills" in n && n.type !== "TEXT") {
          var bp = uxdSingleSolid(n.fills);
          var alias = bp && bp.boundVariables && bp.boundVariables.color;
          var vkey = bp ? uxdColorKey(bp.color, bp.opacity) : "";
          if (alias && alias.id && !seenIds[alias.id + "|" + vkey]) {
            seenIds[alias.id + "|" + vkey] = true;
            var used = await figma.variables.getVariableByIdAsync(alias.id).catch(function () { return null; });
            if (used && used.resolvedType === "COLOR") {
              // Kept apart: the file's own local variables and styles win; a borrowed variable only
              // binds a colour nothing local matches (a root on the file's background style stays).
              var list = palette.usedVariables.get(vkey) || [];
              if (!list.some(function (v) { return v.id === used.id; })) palette.usedVariables.set(vkey, list.concat([used]));
            }
          }
        }
        if ("children" in n && n.type !== "INSTANCE") for (var c = 0; c < n.children.length; c++) stack.push(n.children[c]);
      }
    }
  } catch (_) {}
  return palette;
}
function uxdPickToken(candidates, role) {
  if (!candidates || !candidates.length) return null;
  var prefer = role === "text" ? /text|fg|foreground|content|label|on[-/ ]/i : role === "stroke" ? /border|stroke|outline|divider|line/i : /bg|background|surface|fill|container|card|primary|brand/i;
  var scoped = candidates.filter(function (item) {
    var scopes = Array.isArray(item.scopes) ? item.scopes : null;
    if (!scopes) return true;
    if (scopes.indexOf("ALL_SCOPES") >= 0) return true;
    if (role === "text") return scopes.indexOf("TEXT_FILL") >= 0 || scopes.indexOf("ALL_FILLS") >= 0;
    if (role === "stroke") return scopes.indexOf("STROKE_COLOR") >= 0;
    return scopes.indexOf("ALL_FILLS") >= 0 || scopes.indexOf("FRAME_FILL") >= 0 || scopes.indexOf("SHAPE_FILL") >= 0;
  });
  if (!scoped.length) return null;
  return scoped.slice().sort(function (a, b) {
    var pa = prefer.test(a.name) ? 0 : 1, pb = prefer.test(b.name) ? 0 : 1;
    return pa - pb || String(a.name).length - String(b.name).length || String(a.name).localeCompare(String(b.name));
  })[0];
}
// Snapshot of every property the hygiene fixer changes, so Revert can restore exactly those values
// even after other edits (Figma undo only pops the latest step).
var UXD_HYGIENE_SNAPSHOT = null;
function uxdCloneValue(value) {
  if (typeof value === "symbol" || value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); } catch (_) { return undefined; }
}
function uxdSnapProp(node, prop) {
  if (!UXD_HYGIENE_SNAPSHOT) return;
  var key = node.id + "|" + prop;
  if (UXD_HYGIENE_SNAPSHOT.keys[key]) return;
  var before = uxdCloneValue(node[prop]);
  if (before === undefined && prop !== "minHeight" && prop !== "minWidth") return;
  UXD_HYGIENE_SNAPSHOT.keys[key] = true;
  UXD_HYGIENE_SNAPSHOT.items.push({ node: node, prop: prop, before: before === undefined ? null : before });
}
async function uxdSetPropValue(node, prop, value) {
  if (prop === "reactions" && typeof node.setReactionsAsync === "function") return node.setReactionsAsync(value || []);
  if (prop === "annotations") { node.annotations = uxdCleanAnnotations(value); return; }
  if (prop === "textStyleId" && typeof node.setTextStyleIdAsync === "function") return node.setTextStyleIdAsync(value || "");
  if (prop === "fillStyleId" && typeof node.setFillStyleIdAsync === "function") return node.setFillStyleIdAsync(value || "");
  if (prop === "strokeStyleId" && typeof node.setStrokeStyleIdAsync === "function") return node.setStrokeStyleIdAsync(value || "");
  if (prop === "effectStyleId" && typeof node.setEffectStyleIdAsync === "function") return node.setEffectStyleIdAsync(value || "");
  if ((prop === "width" || prop === "height") && typeof node.resize === "function") {
    return node.resize(prop === "width" ? value : node.width, prop === "height" ? value : node.height);
  }
  node[prop] = value;
}
// Figma normalises some values after a write (reactions gain "action", transitions gain defaults), so
// those compare by what matters: trigger, action type and destination.
function uxdRestoreKey(prop, value) {
  if (value === undefined) value = null;
  if (prop === "reactions") {
    return JSON.stringify((Array.isArray(value) ? value : []).map(function (r) {
      var actions = Array.isArray(r && r.actions) ? r.actions : (r && r.action ? [r.action] : []);
      return [r && r.trigger ? r.trigger.type : "", actions.map(function (a) { return [a && a.type, a && a.destinationId || "", a && a.navigation || ""]; })];
    }));
  }
  if (prop === "annotations") return JSON.stringify(uxdCleanAnnotations(value));
  return JSON.stringify(value);
}
// uxd-componentize:start
// Claude-in-Figma habit: repeated items (loan cards, list rows) are one component plus instances.
// Runs on a frame UX Direct just built: sibling frames with the same structure become a local
// component (the first one) and instances carrying each copy's own text, fills and visibility.
function uxdShapeKey(node, depth) {
  if (depth > 6) return "…";
  var key = node.type + (node.layoutMode && node.layoutMode !== "NONE" ? ":" + node.layoutMode : "");
  if (node.type === "INSTANCE") return key;
  if (!("children" in node)) return key;
  return key + "(" + node.children.map(function (c) { return uxdShapeKey(c, depth + 1); }).join(",") + ")";
}
function uxdPairedNodes(a, b, out) {
  out.push([a, b]);
  if ("children" in a && "children" in b && a.children.length === b.children.length) {
    for (var i = 0; i < a.children.length; i++) uxdPairedNodes(a.children[i], b.children[i], out);
  }
  return out;
}
function uxdVisibleTexts(node) {
  if (!node || !("findAll" in node)) return [];
  return node.findAll(function (n) {
    if (n.type !== "TEXT") return false;
    for (var p = n; p && p !== node; p = p.parent) if (p.visible === false) return false;
    return true;
  }).map(function (n) { return String(n.characters || "").trim(); });
}
// Copies one repeated item's own content onto its new instance: visibility, fills, text, and the
// variant of nested instances (a "Delinquent" badge must not stay "Matured"). Returns false when the
// two trees do not line up, so the caller keeps the original layers instead.
async function uxdSyncInstance(copy, instance) {
  var pairs = uxdPairedNodes(copy, instance, []);
  for (var k = 0; k < pairs.length; k++) {
    var src = pairs[k][0], dst = pairs[k][1];
    if (k > 0 && src.type !== dst.type) return false;
    try {
      if (src.type === "INSTANCE" && dst.type === "INSTANCE") {
        var srcMain = await src.getMainComponentAsync(), dstMain = await dst.getMainComponentAsync();
        if (srcMain && dstMain && srcMain.id !== dstMain.id) {
          dst.swapComponent(srcMain);
          // The swapped instance has new children: pair them again from here.
          var rest = await uxdSyncInstance(src, dst);
          if (!rest) return false;
          continue;
        }
      }
      if (src.visible !== dst.visible) dst.visible = src.visible;
      if ("fills" in src && src.fills !== figma.mixed && JSON.stringify(src.fills) !== JSON.stringify(dst.fills)) dst.fills = src.fills;
      if (src.type === "TEXT" && dst.type === "TEXT" && src.characters !== dst.characters) {
        await uxdLoadTextFonts(dst);
        dst.characters = src.characters;
      }
    } catch (_) {}
  }
  return true;
}
// A row whose real parts (a chip instance with an icon, a copied logo) came out wider than the plan's
// estimate overflows and clips its last item ("slice" logo cut to "slic"; T12): the widest text
// column in that row fills the remaining space instead of keeping its estimated fixed width.
// Room a child has inside its parent: the parent's inner width, minus its siblings in a row.
function uxdAvailableWidth(node) {
  var parent = node.parent;
  if (!parent || typeof parent.width !== "number") return Infinity;
  var inner = parent.width - (parent.paddingLeft || 0) - (parent.paddingRight || 0);
  if (parent.layoutMode === "HORIZONTAL" && parent.layoutWrap !== "WRAP" && node.layoutPositioning !== "ABSOLUTE") {
    var flow = parent.children.filter(function (c) { return c.visible !== false && c.layoutPositioning !== "ABSOLUTE"; });
    var gap = parent.primaryAxisAlignItems === "SPACE_BETWEEN" ? 0 : (parent.itemSpacing || 0);
    var others = flow.filter(function (c) { return c !== node; });
    // A label beside it (growing, or multi-word text that can wrap) gives its room up first,
    // keeping at least 60px; icons, badges and other tokens keep their width.
    var wraps = function (c) {
      if (c.layoutSizingHorizontal === "FILL" || c.layoutGrow === 1) return true;
      var words = function (t) { return /\s/.test(String(t.characters || "").trim()); };
      if (c.type === "TEXT") return words(c);
      return c.type === "FRAME" && typeof c.findAll === "function" && c.findAll(function (k) { return k.type === "TEXT" && words(k); }).length > 0;
    };
    return inner - Math.max(0, flow.length - 1) * gap - others.reduce(function (sum, c) {
      return sum + (wraps(c) ? Math.min(c.width, 60) : c.width);
    }, 0);
  }
  if (parent.layoutMode === "VERTICAL" || parent.layoutMode === "HORIZONTAL") return inner;
  return parent.width - Math.max(0, node.x || 0);
}
// One unbreakable token (an amount like ₹2,00,000, an ID like DMI1234567890) must never wrap
// mid-token or be clipped at its card edge, on any screen. Measured in Figma, not estimated:
// such a text hugs its width; when even that is wider than its room, the type steps down to 11px.
async function uxdFixTokenWrap(root) {
  var fixed = 0;
  var texts = root.findAll(function (n) {
    if (n.type !== "TEXT" || n.visible === false || uxdInsideInstance(n)) return false;
    var value = String(n.characters || "").trim();
    return value.length >= 3 && !/\s/.test(value) && typeof n.fontSize === "number";
  });
  for (var i = 0; i < texts.length; i++) {
    var text = texts[i];
    try {
      var before = { mode: text.textAutoResize, width: text.width, sizing: text.layoutSizingHorizontal };
      var room = uxdAvailableWidth(text);
      await uxdLoadTextFonts(text);
      text.textAutoResize = "WIDTH_AND_HEIGHT";
      var natural = text.width;
      if (natural <= before.width + 0.5 && natural <= room + 0.5) {
        // It already fits on one line: leave it exactly as it was.
        if (before.mode !== "WIDTH_AND_HEIGHT") { text.textAutoResize = before.mode; if (before.mode !== "NONE") text.resize(before.width, text.height); if (before.sizing === "FILL") text.layoutSizingHorizontal = "FILL"; }
        continue;
      }
      var size = text.fontSize;
      while (text.width > room + 0.5 && size > 11) { size -= 1; text.fontSize = size; }
      if (text.parent && (text.parent.layoutMode === "HORIZONTAL" || text.parent.layoutMode === "VERTICAL")) text.layoutSizingHorizontal = "HUG";
      fixed++;
    } catch (_) {}
  }
  return fixed;
}
// A wrapping text (any words) that came out wider than its auto-layout column, even by 1-2px from
// font metrics, is clipped at the column edge: it fills the column and wraps instead (any screen).
async function uxdFitTextsToColumn(root) {
  var fixed = 0;
  var texts = root.findAll(function (n) {
    if (n.type !== "TEXT" || n.visible === false || uxdInsideInstance(n) || n.layoutPositioning === "ABSOLUTE") return false;
    var parent = n.parent;
    if (!parent || parent.layoutMode !== "VERTICAL" || typeof parent.width !== "number") return false;
    if (!/\s/.test(String(n.characters || "").trim())) return false;
    var inner = parent.width - (parent.paddingLeft || 0) - (parent.paddingRight || 0);
    return n.width > inner + 0.5 && n.layoutSizingHorizontal !== "FILL";
  });
  for (var i = 0; i < texts.length; i++) {
    try {
      await uxdLoadTextFonts(texts[i]);
      texts[i].textAutoResize = "HEIGHT";
      texts[i].layoutSizingHorizontal = "FILL";
      fixed++;
    } catch (_) {}
  }
  // A column that holds only text has nothing to mask: it never clips a text's last pixel.
  root.findAll(function (n) {
    return n.type === "FRAME" && n.clipsContent === true && n.layoutMode && n.layoutMode !== "NONE" && !uxdInsideInstance(n) &&
      n.children.length > 0 && n.children.every(function (c) { return c.type === "TEXT"; });
  }).forEach(function (frame) { try { frame.clipsContent = false; fixed++; } catch (_) {} });
  return fixed;
}
async function uxdFixRowOverflow(root) {
  try { await uxdFixTokenWrap(root); } catch (_) {}
  try { await uxdFitTextsToColumn(root); } catch (_) {}
  var fixed = 0, picks = [];
  var rows = root.findAll(function (n) { return n.type === "FRAME" && n.layoutMode === "HORIZONTAL" && n.layoutWrap !== "WRAP" && !uxdInsideInstance(n); });
  rows.forEach(function (row) {
    var flow = row.children.filter(function (c) { return c.visible !== false && c.layoutPositioning !== "ABSOLUTE"; });
    if (flow.length < 2) return;
    var total = (row.paddingLeft || 0) + (row.paddingRight || 0) + Math.max(0, flow.length - 1) * (row.primaryAxisAlignItems === "SPACE_BETWEEN" ? 0 : (row.itemSpacing || 0)) +
      flow.reduce(function (sum, c) { return sum + c.width; }, 0);
    if (total <= row.width + 0.5) return;
    var candidates = flow.filter(function (c) {
      if (c.layoutSizingHorizontal === "FILL") return false;
      if (c.type === "TEXT") return true;
      return c.type === "FRAME" && typeof c.findAll === "function" && c.findAll(function (k) { return k.type === "TEXT"; }).length > 0;
    }).sort(function (a, b) {
      // The label side shrinks, never a one-token value (an amount or an ID stays whole).
      var ta = a.type === "TEXT" && !/\s/.test(String(a.characters || "").trim()) ? 1 : 0;
      var tb = b.type === "TEXT" && !/\s/.test(String(b.characters || "").trim()) ? 1 : 0;
      return ta - tb || b.width - a.width;
    }).filter(function (c) { return !(c.type === "TEXT" && !/\s/.test(String(c.characters || "").trim())); });
    if (candidates[0]) picks.push(candidates[0]);
  });
  for (var i = 0; i < picks.length; i++) {
    var pick = picks[i];
    try {
      if (pick.type === "TEXT" && pick.textAutoResize !== "HEIGHT") { await uxdLoadTextFonts(pick); pick.textAutoResize = "HEIGHT"; }
      pick.layoutSizingHorizontal = "FILL";
      fixed++;
    } catch (_) {}
  }
  return fixed;
}
async function localComponentizeRepeats(payload) {
  var root = payload && payload.rootId ? await figma.getNodeByIdAsync(String(payload.rootId)) : figma.currentPage.selection[0];
  if (root && typeof root.findAll === "function") { try { await uxdFixRowOverflow(root); } catch (_) {} }
  if (!root || !("findAll" in root) || typeof figma.createComponentFromNode !== "function") return { ok: true, components: 0, instances: 0 };
  var components = 0, instances = 0, kept = 0;
  var parents = [root].concat(root.findAll(function (n) { return n.type === "FRAME" && n.children && n.children.length >= 2; }));
  for (var p = 0; p < parents.length && components < 6; p++) {
    var parent = parents[p];
    if (!parent || parent.removed || !("children" in parent)) continue;
    var groups = {};
    parent.children.forEach(function (child) {
      if (child.type !== "FRAME" || child.visible === false) return;
      var size = child.findAll ? child.findAll(function () { return true; }).length : 0;
      if (size < 3 || !child.findAll(function (n) { return n.type === "TEXT"; }).length) return;
      var key = uxdShapeKey(child, 0) + "|" + Math.round(child.width);
      (groups[key] = groups[key] || []).push(child);
    });
    for (var key in groups) {
      var group = groups[key];
      if (group.length < 2) continue;
      var first = group[0];
      var component = figma.createComponentFromNode(first);
      if (!component || component.type !== "COMPONENT") continue;
      component.name = String(component.name || "Item").replace(/\s*\d+$/, "").slice(0, 60) || "Item";
      components++;
      for (var g = 1; g < group.length; g++) {
        var copy = group[g];
        var instance = component.createInstance();
        var at = parent.children.indexOf(copy);
        parent.insertChild(at, instance);
        ["layoutSizingHorizontal", "layoutSizingVertical", "layoutGrow", "layoutAlign"].forEach(function (prop) {
          try { if (prop in copy) instance[prop] = copy[prop]; } catch (_) {}
        });
        var synced = await uxdSyncInstance(copy, instance);
        // Every text must read exactly as in the original item, in the same order; otherwise the
        // instance is dropped and the original layers stay (no content may move between cards).
        if (!synced || uxdVisibleTexts(copy).join("\u0001") !== uxdVisibleTexts(instance).join("\u0001")) {
          instance.remove();
          kept++;
          continue;
        }
        instance.name = copy.name;
        copy.remove();
        instances++;
      }
    }
  }
  return { ok: true, components: components, instances: instances, kept: kept };
}
// uxd-componentize:end
async function localRestoreProps(payload) {
  var items = Array.isArray(payload.items) ? payload.items.slice(0, 3000) : [];
  var restored = 0, changedSince = 0, missing = 0;
  if (typeof figma.commitUndo === "function") figma.commitUndo();
  for (var i = items.length - 1; i >= 0; i--) {
    var item = items[i];
    var node = await figma.getNodeByIdAsync(String(item.id || ""));
    if (!node || node.removed) { missing++; continue; }
    if (uxdRestoreKey(item.prop, uxdCloneValue(node[item.prop])) !== uxdRestoreKey(item.prop, item.after)) { changedSince++; continue; }
    try {
      if (node.type === "TEXT") await uxdLoadTextFonts(node);
      if (item.prop === "fontName" && item.before && item.before.family) await figma.loadFontAsync(item.before);
      await uxdSetPropValue(node, item.prop, item.before);
      restored++;
    } catch (_) { missing++; }
  }
  if (typeof figma.commitUndo === "function") figma.commitUndo();
  return { ok: true, restored: restored, changedSince: changedSince, missing: missing };
}
function uxdNearestColorKey(color, opacity, palette) {
  var alpha = Math.round((opacity === undefined ? 1 : opacity) * 100);
  var best = null, bestDist = 0.035; // ~9/255 per channel: imperceptible on screen
  [palette.variables, palette.styles].forEach(function (map) {
    map.forEach(function (_v, key) {
      var parts = String(key).split("/");
      if (Number(parts[1]) !== alpha || !/^[0-9A-F]{6}$/.test(parts[0])) return;
      var c = { r: parseInt(parts[0].slice(0, 2), 16) / 255, g: parseInt(parts[0].slice(2, 4), 16) / 255, b: parseInt(parts[0].slice(4, 6), 16) / 255 };
      var d = Math.sqrt(Math.pow(c.r - color.r, 2) + Math.pow(c.g - color.g, 2) + Math.pow(c.b - color.b, 2));
      if (d < bestDist) { bestDist = d; best = key; }
    });
  });
  return best;
}
async function uxdBindPaintToken(node, prop, palette, role) {
  var styleProp = prop === "fills" ? "fillStyleId" : "strokeStyleId";
  if (typeof node[styleProp] === "string" && node[styleProp]) return false;
  if (uxdBound(node, prop)) return false;
  var paint = uxdSingleSolid(node[prop]);
  if (!paint || (paint.boundVariables && paint.boundVariables.color)) return false;
  var key = uxdColorKey(paint.color, paint.opacity);
  // No exact match: take the nearest file colour when it is visually the same (a renderer or a model
  // rounding #0EA5E9 to #0EA4E8 must still land on the file's style, the way a designer would).
  if (!palette.variables.has(key) && !palette.styles.has(key)) key = uxdNearestColorKey(paint.color, paint.opacity, palette) || key;
  var variable = uxdPickToken(palette.variables.get(key), role);
  if (variable && figma.variables && typeof figma.variables.setBoundVariableForPaint === "function") {
    if (node.type === "TEXT") await uxdLoadTextFonts(node);
    uxdSnapProp(node, prop);
    node[prop] = [figma.variables.setBoundVariableForPaint(paint, "color", variable)];
    return "variable";
  }
  var style = uxdPickToken(palette.styles.get(key), role);
  if (!style) {
    var exact = uxdColorKey(paint.color, paint.opacity);
    // The source already paints with it, so its scopes are not second-guessed here.
    var usedList = palette.usedVariables ? palette.usedVariables.get(exact) : null;
    var borrowed = usedList && usedList.length ? uxdPickToken(usedList, role) || usedList[0] : null;
    if (!borrowed || !figma.variables || typeof figma.variables.setBoundVariableForPaint !== "function") return false;
    if (node.type === "TEXT") await uxdLoadTextFonts(node);
    uxdSnapProp(node, prop);
    node[prop] = [figma.variables.setBoundVariableForPaint(paint, "color", borrowed)];
    return "variable";
  }
  if (node.type === "TEXT") await uxdLoadTextFonts(node);
  var setter = prop === "fills" ? "setFillStyleIdAsync" : "setStrokeStyleIdAsync";
  uxdSnapProp(node, prop); uxdSnapProp(node, styleProp);
  if (typeof node[setter] === "function") await node[setter](style.id);
  else node[styleProp] = style.id;
  return "style";
}
function uxdSameNumberish(a, b) {
  if (a && typeof a === "object" && b && typeof b === "object") {
    if (a.unit !== b.unit) return false;
    if (a.unit === "AUTO") return true;
    return Math.abs(Number(a.value) - Number(b.value)) < 0.01;
  }
  return a === b;
}
// Line height in px for comparison (AUTO ~ 1.2 x size), so 20px and 125% on a 16px font count as equal.
function uxdLineHeightPx(lineHeight, fontSize) {
  if (!lineHeight || typeof lineHeight !== "object") return null;
  if (lineHeight.unit === "AUTO") return fontSize * 1.2;
  if (lineHeight.unit === "PERCENT") return fontSize * Number(lineHeight.value) / 100;
  return Number(lineHeight.value);
}
function uxdLetterSpacingPx(spacing, fontSize) {
  if (!spacing || typeof spacing !== "object") return 0;
  return spacing.unit === "PERCENT" ? fontSize * Number(spacing.value) / 100 : Number(spacing.value);
}
// Same family, weight and size is required; among those, the closest line height and letter spacing wins
// (within 2px / 0.5px), the way a designer would pick "Body/Medium" for an unstyled 14 Medium text.
function uxdMatchTextStyle(node, styles) {
  if (typeof node.textStyleId === "string" && node.textStyleId) return null;
  if (!node.fontName || typeof node.fontName !== "object" || typeof node.fontSize !== "number") return null;
  var nodeLh = uxdLineHeightPx(node.lineHeight, node.fontSize);
  var nodeLs = uxdLetterSpacingPx(node.letterSpacing, node.fontSize);
  var scored = styles.filter(function (style) {
    return style.fontName && style.fontName.family === node.fontName.family && style.fontName.style === node.fontName.style &&
      Math.abs(style.fontSize - node.fontSize) < 0.01 &&
      (style.textCase === undefined || node.textCase === undefined || style.textCase === node.textCase || style.textCase === "ORIGINAL") &&
      (style.textDecoration === undefined || node.textDecoration === undefined || style.textDecoration === node.textDecoration);
  }).map(function (style) {
    var lh = uxdLineHeightPx(style.lineHeight, style.fontSize);
    var lhGap = nodeLh === null || lh === null ? 0 : Math.abs(lh - nodeLh);
    var lsGap = Math.abs(uxdLetterSpacingPx(style.letterSpacing, style.fontSize) - nodeLs);
    return { style: style, lhGap: lhGap, lsGap: lsGap };
  }).filter(function (x) { return x.lhGap <= 2 && x.lsGap <= 0.5; });
  scored.sort(function (a, b) { return (a.lhGap + a.lsGap) - (b.lhGap + b.lsGap) || String(a.style.name).localeCompare(String(b.style.name)); });
  if (scored.length) return scored[0].style;
  // No exact style: the nearest one of the same family and weight within 1px (10px Bold → 11px Bold,
  // 11.72px → 12px). It changes the size by at most 1px, so it is marked "near" and fully snapshotted.
  var weight = uxdFontWeight(node.fontName.style);
  var near = styles.filter(function (style) {
    return style.fontName && style.fontName.family === node.fontName.family && uxdFontWeight(style.fontName.style) === weight &&
      /italic/i.test(style.fontName.style) === /italic/i.test(node.fontName.style) &&
      Math.abs(style.fontSize - node.fontSize) <= 1.01 &&
      (style.textCase === undefined || node.textCase === undefined || style.textCase === node.textCase || style.textCase === "ORIGINAL");
  }).map(function (style) {
    var lh = uxdLineHeightPx(style.lineHeight, style.fontSize);
    var lhGap = nodeLh === null || lh === null ? 0 : Math.abs(lh - nodeLh);
    return { style: style, lhGap: lhGap, gap: Math.abs(style.fontSize - node.fontSize) * 2 + lhGap / 4 };
  }).filter(function (x) { return x.lhGap <= 4; });
  near.sort(function (a, b) { return a.gap - b.gap || String(a.style.name).localeCompare(String(b.style.name)); });
  return near.length ? { id: near[0].style.id, name: near[0].style.name, fontName: near[0].style.fontName, fontSize: near[0].style.fontSize, near: true } : null;
}
function uxdFontWeight(style) {
  var s = String(style || "").toLowerCase().replace(/[\s_-]+/g, "");
  if (/thin|hairline/.test(s)) return 100;
  if (/extralight|ultralight/.test(s)) return 200;
  if (/light/.test(s)) return 300;
  if (/semibold|demibold/.test(s)) return 600;
  if (/extrabold|ultrabold/.test(s)) return 800;
  if (/black|heavy/.test(s)) return 900;
  if (/bold/.test(s)) return 700;
  if (/medium/.test(s)) return 500;
  return 400;
}
function uxdTextBackground(node) {
  for (var parent = node.parent; parent && parent.type !== "PAGE"; parent = parent.parent) {
    if (!Array.isArray(parent.fills)) continue;
    var visible = parent.fills.filter(function (p) { return p && p.visible !== false; });
    if (!visible.length) continue;
    var top = visible[visible.length - 1];
    return top.type === "SOLID" ? top.color : null;
  }
  return null;
}
// uxd-theme:start
// "Make this screen light/dark mode", in place: switch the variable mode when the screen's colours come
// from a collection with Light/Dark modes, otherwise remap hard-coded colours (neutrals flip lightness,
// brand colours keep their hue), then lift any text that falls below WCAG AA. Snapshotted for Revert.
function uxdRgbToHsl(c) {
  var max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b), l = (max + min) / 2, h = 0, s = 0;
  if (max !== min) {
    var d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === c.r ? (c.g - c.b) / d + (c.g < c.b ? 6 : 0) : max === c.g ? (c.b - c.r) / d + 2 : (c.r - c.g) / d + 4;
    h /= 6;
  }
  return { h: h, s: s, l: l };
}
function uxdHslToRgb(x) {
  if (x.s === 0) return { r: x.l, g: x.l, b: x.l };
  function f(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
  var q = x.l < 0.5 ? x.l * (1 + x.s) : x.l + x.s - x.l * x.s, p = 2 * x.l - q;
  return { r: f(p, q, x.h + 1 / 3), g: f(p, q, x.h), b: f(p, q, x.h - 1 / 3) };
}
function uxdThemeColor(color, toLight, isText) {
  var hsl = uxdRgbToHsl(color);
  // Chroma, not HSL saturation: near-black slates (#111827) have high saturation but read as neutral.
  var chroma = Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
  if (chroma < 0.14) {
    // A neutral already right for the asked mode stays (light mode: light surfaces, dark ink), so a
    // second run or a half-themed screen is not flipped back (tester T8: two runs left the arrow dark).
    if (toLight ? (isText ? hsl.l < 0.45 : hsl.l > 0.55) : (isText ? hsl.l > 0.55 : hsl.l < 0.45)) return color;
    // Neutral: mirror lightness, with a soft floor/ceiling (pure black/white read harsh in both modes).
    var l = 1 - hsl.l;
    l = toLight ? Math.min(0.99, Math.max(isText ? 0.1 : 0.12, l)) : Math.max(0.06, Math.min(isText ? 0.95 : 0.92, l));
    return uxdHslToRgb({ h: hsl.h, s: hsl.s, l: l });
  }
  // Brand/accent: same hue; only move lightness when it would vanish on the new background.
  if (toLight && hsl.l > 0.72) hsl.l = isText ? 0.4 : 0.9;
  if (!toLight && hsl.l < 0.3) hsl.l = isText ? 0.7 : 0.35;
  return uxdHslToRgb(hsl);
}
async function uxdThemeModeSwitch(root, toLight) {
  if (!figma.variables || typeof root.setExplicitVariableModeForCollection !== "function") return null;
  var used = {};
  (function walk(n, depth) {
    if (!n || depth > 8) return;
    ["fills", "strokes"].forEach(function (prop) {
      if (!Array.isArray(n[prop])) return;
      n[prop].forEach(function (paint) { if (paint && paint.boundVariables && paint.boundVariables.color) used[paint.boundVariables.color.id] = true; });
    });
    if (Array.isArray(n.children)) n.children.forEach(function (c) { walk(c, depth + 1); });
  })(root, 0);
  var ids = Object.keys(used);
  if (!ids.length) return null;
  for (var i = 0; i < ids.length; i++) {
    var variable = await figma.variables.getVariableByIdAsync(ids[i]);
    if (!variable) continue;
    var collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
    if (!collection || !Array.isArray(collection.modes)) continue;
    var want = collection.modes.find(function (m) { return (toLight ? /light|day|default/i : /dark|night/i).test(m.name); });
    if (!want) continue;
    var before = root.explicitVariableModes ? root.explicitVariableModes[collection.id] : undefined;
    root.setExplicitVariableModeForCollection(collection, want.modeId);
    return { collectionId: collection.id, collectionName: collection.name, modeName: want.name, before: before || null, nodeId: root.id };
  }
  return null;
}
function uxdScreenBackgroundLuminance(root) {
  var own = uxdSingleSolid(root.fills);
  if (own) return uxdLuminance(own.color);
  var best = null, area = 0;
  if (typeof root.findAll === "function") root.findAll(function (n) {
    var p = n.visible !== false && "fills" in n ? uxdSingleSolid(n.fills) : null;
    if (p && n.width * n.height > area) { area = n.width * n.height; best = p; }
    return false;
  });
  return best ? uxdLuminance(best.color) : null;
}
async function localApplyTheme(payload) {
  var toLight = payload.target !== "dark";
  var roots = figma.currentPage.selection.slice();
  if (!roots.length) throw new Error("Select the screen to switch to " + (toLight ? "light" : "dark") + " mode.");
  if (typeof figma.commitUndo === "function") figma.commitUndo();
  var modes = [];
  for (var r = 0; r < roots.length; r++) {
    var switched = await uxdThemeModeSwitch(roots[r], toLight);
    if (switched) modes.push(switched);
  }
  UXD_HYGIENE_SNAPSHOT = { keys: {}, items: [] };
  var changed = 0, contrast = 0, already = 0;
  var nodes = uxdHygieneNodes(roots, true);
  // Skip screens that are already in the asked mode (background luminance decides).
  var rootBg = roots.map(function (root) { var p = uxdSingleSolid(root.fills); return p ? uxdLuminance(p.color) : null; });
  var isAlready = rootBg.every(function (l) { return l !== null && (toLight ? l > 0.5 : l < 0.2); });
  if (!modes.length && isAlready) already = roots.length;
  else {
    // Colours bound to a variable whose collection has no matching mode would never change (the
    // screen and its cards stayed dark while only loose neutrals flipped; tester T8): those paints
    // are remapped from their current colour and unbound. Revert restores the binding.
    var switchedCollections = {};
    modes.forEach(function (m) { switchedCollections[m.collectionId] = true; });
    var variableCollection = {};
    for (var vi = 0; vi < nodes.length; vi++) {
      ["fills", "strokes"].forEach(function (prop) {
        var list = nodes[vi][prop];
        if (!Array.isArray(list)) return;
        list.forEach(function (paint) { if (paint && paint.boundVariables && paint.boundVariables.color) variableCollection[paint.boundVariables.color.id] = null; });
      });
    }
    var variableIds = Object.keys(variableCollection);
    for (var vj = 0; vj < variableIds.length; vj++) {
      try { var v = await figma.variables.getVariableByIdAsync(variableIds[vj]); variableCollection[variableIds[vj]] = v ? v.variableCollectionId : null; } catch (_) {}
    }
    var keepsBinding = function (paint) {
      var id = paint && paint.boundVariables && paint.boundVariables.color && paint.boundVariables.color.id;
      return !!id && !!switchedCollections[variableCollection[id]];
    };
    // Figma node proxies are not extensible: keep pending text fills in a Map, never on the node.
    var pendingFills = new Map();
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var isText = node.type === "TEXT";
      // Icons and glyphs are ink like text: a white back arrow turns dark on a light screen.
      var isInk = isText || ["VECTOR", "BOOLEAN_OPERATION", "LINE", "STAR", "POLYGON"].indexOf(node.type) >= 0;
      ["fills", "strokes"].forEach(function (prop) {
        if (!(prop in node) || !Array.isArray(node[prop]) || !node[prop].length) return;
        var next = node[prop].map(function (paint) {
          if (!paint || paint.type !== "SOLID" || keepsBinding(paint)) return paint;
          var out = Object.assign({}, paint, { color: uxdThemeColor(paint.color, toLight, isInk) });
          delete out.boundVariables;
          return out;
        });
        if (JSON.stringify(next) === JSON.stringify(node[prop])) return;
        uxdSnapProp(node, prop);
        if (isText && prop === "fills") { pendingFills.set(node, next); return; }
        node[prop] = next;
        changed++;
      });
    }
    // Text needs its fonts loaded before fills change.
    for (var t = 0; t < nodes.length; t++) {
      var pending = pendingFills.get(nodes[t]);
      if (!pending) continue;
      try { await uxdLoadTextFonts(nodes[t]); nodes[t].fills = pending; changed++; } catch (_) {}
    }
  }
  // Contrast pass: any text below 4.5:1 on its background goes to the mode's text colour.
  for (var c = 0; c < nodes.length; c++) {
    var text = nodes[c];
    if (text.type !== "TEXT") continue;
    var paint = uxdSingleSolid(text.fills), bg = uxdTextBackground(text);
    if (!paint || !bg || (paint.boundVariables && paint.boundVariables.color)) continue;
    var need = Number(text.fontSize) >= 18 ? 3 : 4.5;
    if (uxdContrast(paint.color, bg) >= need) continue;
    var dark = { r: 0.07, g: 0.09, b: 0.15 }, light = { r: 0.96, g: 0.97, b: 0.98 };
    var pick = uxdContrast(dark, bg) >= uxdContrast(light, bg) ? dark : light;
    try {
      await uxdLoadTextFonts(text);
      uxdSnapProp(text, "fills");
      text.fills = [Object.assign({}, paint, { color: pick })];
      contrast++;
    } catch (_) {}
  }
  if (typeof figma.commitUndo === "function") figma.commitUndo();
  var snapshot = UXD_HYGIENE_SNAPSHOT.items.map(function (item) {
    var after = uxdCloneValue(item.node[item.prop]);
    return { id: item.node.id, prop: item.prop, before: item.before, after: after === undefined ? null : after };
  });
  UXD_HYGIENE_SNAPSHOT = null;
  // Read back what the screen shows now: its own background, or its largest filled layer.
  var unverified = [];
  roots.forEach(function (root) {
    var lum = uxdScreenBackgroundLuminance(root);
    if (lum !== null && (toLight ? lum < 0.5 : lum > 0.2)) unverified.push(String(root.name).slice(0, 40));
  });
  return { ok: true, target: toLight ? "light" : "dark", modes: modes, changed: changed, contrast: contrast, already: already, checked: nodes.length, snapshot: snapshot,
    verified: unverified.length === 0, unverified: unverified };
}
async function localRestoreThemeModes(payload) {
  var items = Array.isArray(payload.modes) ? payload.modes : [];
  var restored = 0;
  for (var i = 0; i < items.length; i++) {
    var node = await figma.getNodeByIdAsync(String(items[i].nodeId || ""));
    if (!node || typeof node.setExplicitVariableModeForCollection !== "function") continue;
    var collection = await figma.variables.getVariableCollectionByIdAsync(items[i].collectionId);
    if (!collection) continue;
    if (items[i].before) node.setExplicitVariableModeForCollection(collection, items[i].before);
    else if (typeof node.clearExplicitVariableModeForCollection === "function") node.clearExplicitVariableModeForCollection(collection);
    restored++;
  }
  return { ok: true, restored: restored };
}
// uxd-theme:end
function uxdRoleName(node) {
  var kids = (node.children || []).filter(function (c) { return c && c.visible !== false; });
  var texts = kids.filter(function (c) { return c.type === "TEXT"; });
  var firstText = texts.length ? String(texts[0].characters || "").trim().replace(/\s+/g, " ") : "";
  var short = firstText.length && firstText.length <= 24 ? firstText : "";
  var filled = Array.isArray(node.fills) && node.fills.some(function (f) { return f && f.visible !== false && f.type === "SOLID" && (f.opacity === undefined || f.opacity > 0); });
  var h = Number(node.height) || 0;
  if (kids.length === 0) return filled ? "Shape" : "";
  if (texts.length === 1 && kids.length <= 2 && filled && h >= 28 && h <= 60 && short) return "Button / " + short;
  if (texts.length === 1 && kids.length <= 2 && filled && h < 28 && short) return "Badge / " + short;
  if (filled && kids.length >= 2 && Number(node.cornerRadius) > 0) return short ? "Card / " + short : "Card";
  if (node.layoutMode === "HORIZONTAL") return short ? "Row / " + short : "Row";
  if (node.layoutMode === "VERTICAL") return short ? "Stack / " + short : "Stack";
  return short ? "Group / " + short : "Group";
}
async function localApplyHygieneFixes(payload) {
  var groups = Array.isArray(payload.groups) ? payload.groups.filter(function (g) { return UXD_HYGIENE_GROUPS.indexOf(g) >= 0; }) : [];
  if (!groups.length) groups = ["spacing", "tokens"];
  var roots = figma.currentPage.selection.slice();
  if (!roots.length) throw new Error("Select the screen (or layers) to fix first.");
  var nodes = uxdHygieneNodes(roots);
  UXD_HYGIENE_SNAPSHOT = { keys: {}, items: [] };
  UXD_ACTIVE_RULES = uxdReadDesignRules().rules;
  var minText = UXD_ACTIVE_RULES && typeof UXD_ACTIVE_RULES.minText === "number" ? UXD_ACTIVE_RULES.minText : 12;
  var counts = { spacing: 0, symmetry: 0, repeated: 0, radius: 0, colorVariables: 0, colorStyles: 0, textStyles: 0, contrast: 0, smallText: 0, touchTargets: 0, autoLayout: 0, names: 0 };
  var skipped = [];
  function skip(message) { if (skipped.length < 8 && skipped.indexOf(message) < 0) skipped.push(message); }
  var has = function (g) { return groups.indexOf(g) >= 0; };
  // Fonts first, so the whole fix is one undo step.
  var texts = nodes.filter(function (n) { return n.type === "TEXT"; });
  var a11yTexts = has("a11y") ? uxdHygieneNodes(roots, true).filter(function (n) { return n.type === "TEXT"; }) : [];
  var fontTexts = a11yTexts.length ? a11yTexts : texts;
  for (var t = 0; t < fontTexts.length; t++) { try { await uxdLoadTextFonts(fontTexts[t]); } catch (_) {} }
  if (typeof figma.commitUndo === "function") figma.commitUndo();

  if (has("layout")) {
    var stacks = nodes.filter(function (n) {
      if (["FRAME", "COMPONENT"].indexOf(n.type) < 0 || uxdHasAutoLayout(n)) return false;
      var kids = (n.children || []).filter(function (c) { return c.visible !== false && c.layoutPositioning !== "ABSOLUTE"; });
      return kids.length >= 2;
    });
    for (var s = 0; s < stacks.length; s++) {
      if (!uxdInferLayout(stacks[s])) { skip("\"" + String(stacks[s].name).slice(0, 30) + "\" has overlapping layers, so auto layout was not forced"); continue; }
      try { if (uxdEnableAutoLayout(stacks[s], null)) counts.autoLayout++; } catch (error) { skip(String(error && error.message || error).slice(0, 120)); }
    }
  }
  if (has("spacing")) {
    var frames = nodes.filter(function (n) { return n.type !== "INSTANCE" && uxdHasAutoLayout(n); });
    frames.forEach(function (frame) {
      var changed = false;
      ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "itemSpacing"].forEach(function (prop) {
        if (prop === "itemSpacing" && frame.primaryAxisAlignItems === "SPACE_BETWEEN") return;
        if (uxdBound(frame, prop) || typeof frame[prop] !== "number") return;
        var snapped = uxdSnapToGrid(frame[prop]);
        if (snapped !== frame[prop]) { uxdSnapProp(frame, prop); frame[prop] = snapped; changed = true; }
      });
      if (changed) counts.spacing++;
      var left = frame.paddingLeft, right = frame.paddingRight;
      if (typeof left === "number" && typeof right === "number" && left !== right && Math.abs(left - right) <= 8 &&
          !uxdBound(frame, "paddingLeft") && !uxdBound(frame, "paddingRight")) {
        var both = Math.max(left, right);
        uxdSnapProp(frame, "paddingLeft"); uxdSnapProp(frame, "paddingRight");
        frame.paddingLeft = both; frame.paddingRight = both; counts.symmetry++;
      }
    });
    // File design rules: corner radii snap to the file's allowed radii (pills and circles excluded).
    var radii = UXD_ACTIVE_RULES && Array.isArray(UXD_ACTIVE_RULES.radii) && UXD_ACTIVE_RULES.radii.length ? UXD_ACTIVE_RULES.radii : null;
    if (radii) nodes.forEach(function (n) {
      if (n.type === "INSTANCE" || n.type === "ELLIPSE" || typeof n.cornerRadius !== "number" || n.cornerRadius <= 0 || uxdBound(n, "cornerRadius")) return;
      if (n.cornerRadius >= Math.min(n.width, n.height) / 2 - 0.5) return;
      var r = uxdNearest(radii, n.cornerRadius);
      if (r !== n.cornerRadius) { uxdSnapProp(n, "cornerRadius"); n.cornerRadius = r; counts.radius++; }
    });
    // Repeated items (same type + name under one parent) that drifted apart get the most common
    // padding, gap and radius of the group, the same grouping the hygiene check reports.
    var parents = roots.concat(nodes).filter(function (n, i, all) { return Array.isArray(n.children) && n.type !== "INSTANCE" && all.indexOf(n) === i; });
    parents.forEach(function (parent) {
      var groupsByName = {};
      parent.children.forEach(function (kid) {
        if (["FRAME", "COMPONENT"].indexOf(kid.type) < 0 || kid.visible === false || kid.locked === true) return;
        var key = kid.type + "|" + kid.name;
        (groupsByName[key] = groupsByName[key] || []).push(kid);
      });
      Object.keys(groupsByName).forEach(function (key) {
        var group = groupsByName[key];
        if (group.length < 2) return;
        var touched = {};
        ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "itemSpacing", "cornerRadius"].forEach(function (prop) {
          var tally = {}, best = null;
          group.forEach(function (item) {
            if (typeof item[prop] !== "number") return;
            tally[item[prop]] = (tally[item[prop]] || 0) + 1;
            if (best === null || tally[item[prop]] > tally[best]) best = item[prop];
          });
          if (best === null) return;
          group.forEach(function (item) {
            if (typeof item[prop] !== "number" || item[prop] === best || uxdBound(item, prop)) return;
            if (prop !== "cornerRadius" && !uxdHasAutoLayout(item)) return;
            uxdSnapProp(item, prop); item[prop] = best; touched[item.id] = true;
          });
        });
        counts.repeated += Object.keys(touched).length;
      });
    });
  }
  if (has("a11y")) {
    for (var a = 0; a < a11yTexts.length; a++) {
      var text = a11yTexts[a];
      if (typeof text.fontSize === "number" && text.fontSize < minText && !uxdBound(text, "fontSize") && !(typeof text.textStyleId === "string" && text.textStyleId)) {
        try { uxdSnapProp(text, "fontSize"); text.fontSize = minText; counts.smallText++; } catch (_) {}
      }
      var fg = uxdSingleSolid(text.fills);
      var bg = uxdTextBackground(text);
      if (!fg || !bg) continue;
      var size = typeof text.fontSize === "number" ? text.fontSize : 14;
      var bold = text.fontName && typeof text.fontName === "object" && /bold|semi|heavy|black/i.test(text.fontName.style);
      var required = size >= 24 || (size >= 18.5 && bold) ? 3 : 4.5;
      if (uxdContrast(fg.color, bg) >= required) continue;
      if ((typeof text.fillStyleId === "string" && text.fillStyleId) || uxdBound(text, "fills") || (fg.boundVariables && fg.boundVariables.color)) {
        skip("\"" + String(text.name).slice(0, 30) + "\" fails contrast but uses a colour token; change the token instead");
        continue;
      }
      var darken = uxdLuminance(bg) > 0.18;
      var color = { r: fg.color.r, g: fg.color.g, b: fg.color.b };
      for (var step = 0; step < 40 && uxdContrast(color, bg) < required + 0.05; step++) color = uxdShiftColor(color, darken ? -0.06 : 0.06);
      if (uxdContrast(color, bg) < required) { skip("\"" + String(text.name).slice(0, 30) + "\" is already " + (darken ? "black" : "white") + "; darken its background to pass contrast"); continue; }
      uxdSnapProp(text, "fills");
      text.fills = [{ type: "SOLID", color: color, opacity: fg.opacity === undefined ? 1 : fg.opacity, visible: true }];
      counts.contrast++;
    }
    nodes.forEach(function (n) {
      if (n.type === "TEXT" || !UXD_HYGIENE_INTERACTIVE.test(String(n.name)) || !(n.width < 44 || n.height < 44)) return;
      if (!uxdHasAutoLayout(n) || !("minHeight" in n || "minWidth" in n)) {
        skip("\"" + String(n.name).slice(0, 30) + "\" is under 44×44 without auto layout; give it a 44px hit area by hand");
        return;
      }
      try {
        if (n.height < 44) { uxdSnapProp(n, "minHeight"); n.minHeight = 44; }
        if (n.width < 44) { uxdSnapProp(n, "minWidth"); n.minWidth = 44; }
        counts.touchTargets++;
      } catch (error) { skip("\"" + String(n.name).slice(0, 30) + "\": " + String(error && error.message || error).slice(0, 80)); }
    });
  }
  // Semantic layer names for containers still called "Frame 2095587013" / "Group 12" (own layers only).
  if (has("names")) {
    for (var nm = 0; nm < nodes.length; nm++) {
      var layer = nodes[nm];
      if (!/^(frame|group|rectangle|auto layout)(\s+\d+)?$/i.test(String(layer.name || "").trim())) continue;
      if (!Array.isArray(layer.children) || layer.type === "INSTANCE") continue;
      var role = uxdRoleName(layer);
      if (!role || role === layer.name) continue;
      uxdSnapProp(layer, "name");
      layer.name = role;
      counts.names++;
    }
  }
  if (has("tokens")) {
    var palette = await uxdHygienePalette();
    var textStyles = [];
    try { textStyles = await figma.getLocalTextStylesAsync(); } catch (_) {}
    if (!palette.styles.size && !palette.variables.size && !textStyles.length) skip("this file has no local colour variables, colour styles or text styles to bind to");
    for (var k = 0; k < nodes.length; k++) {
      var node = nodes[k];
      if (node.type === "INSTANCE") continue;
      var role = node.type === "TEXT" ? "text" : "fill";
      try {
        if ("fills" in node) {
          var fill = await uxdBindPaintToken(node, "fills", palette, role);
          if (fill === "variable") counts.colorVariables++; else if (fill === "style") counts.colorStyles++;
        }
        if ("strokes" in node && node.type !== "TEXT") {
          var stroke = await uxdBindPaintToken(node, "strokes", palette, "stroke");
          if (stroke === "variable") counts.colorVariables++; else if (stroke === "style") counts.colorStyles++;
        }
      } catch (error) { skip("\"" + String(node.name).slice(0, 30) + "\": " + String(error && error.message || error).slice(0, 80)); }
    }
    // Text styles also bind on text inside instances (a style override is a normal instance override):
    // cards and rows are usually instances, so skipping them left almost every text unstyled.
    if (textStyles.length) {
      var styleTexts = uxdHygieneNodes(roots, true).filter(function (n) { return n.type === "TEXT"; });
      var noStyle = {};
      for (var ts = 0; ts < styleTexts.length; ts++) {
        var text = styleTexts[ts];
        try {
          var match = uxdMatchTextStyle(text, textStyles);
          if (!match) {
            // Say which size/weight the file has no style for, instead of leaving them silently (T10).
            if (!text.textStyleId && typeof text.fontSize === "number" && text.fontName !== figma.mixed && text.fontName) {
              var combo = Math.round(text.fontSize) + "px " + String(text.fontName.style || "Regular");
              noStyle[combo] = (noStyle[combo] || 0) + 1;
            }
            continue;
          }
          await uxdLoadTextFonts(text);
          if (match.fontName) await figma.loadFontAsync(match.fontName);
          // A near style changes size/line height slightly: snapshot them so Revert is exact.
          if (match.near) ["fontName", "fontSize", "lineHeight", "letterSpacing"].forEach(function (prop) { uxdSnapProp(text, prop); });
          uxdSnapProp(text, "textStyleId");
          if (typeof text.setTextStyleIdAsync === "function") await text.setTextStyleIdAsync(match.id);
          else text.textStyleId = match.id;
          counts.textStyles++;
        } catch (error) { skip("\"" + String(text.name).slice(0, 30) + "\": " + String(error && error.message || error).slice(0, 80)); }
      }
      Object.keys(noStyle).sort(function (a, b) { return noStyle[b] - noStyle[a]; }).slice(0, 4).forEach(function (combo) {
        skip(noStyle[combo] + " text layer(s) at " + combo + ": this file has no text style of that size and weight");
      });
    }
  }
  if (typeof figma.commitUndo === "function") figma.commitUndo();
  var total = Object.keys(counts).reduce(function (sum, key) { return sum + counts[key]; }, 0);
  var snapshot = UXD_HYGIENE_SNAPSHOT.items.map(function (item) {
    var after = uxdCloneValue(item.node[item.prop]);
    return { id: item.node.id, prop: item.prop, before: item.before, after: after === undefined ? null : after };
  });
  UXD_HYGIENE_SNAPSHOT = null;
  var usedRules = Boolean(UXD_ACTIVE_RULES);
  var usedSpacingScale = Boolean(UXD_ACTIVE_RULES && Array.isArray(UXD_ACTIVE_RULES.spacing) && UXD_ACTIVE_RULES.spacing.length);
  UXD_ACTIVE_RULES = null;
  return { ok: true, usedRules: usedRules, usedSpacingScale: usedSpacingScale, groups: groups, counts: counts, total: total, checked: nodes.length, skipped: skipped,
    snapshot: snapshot, layoutChanged: counts.autoLayout > 0 };
}
// uxd-hygiene-fix:end
// uxd-fill-data:start
// Realistic Indian BFSI sample data, no model: every value text in the selection (amounts, dates, masked
// accounts, reference IDs, PAN, phone, rates, person names) gets a varied value in the SAME format, so
// repeated rows stop looking copy-pasted. Labels, headings, buttons and statuses are never touched.
// Values are seeded by layer id, so the same selection always gets the same data.
var UXD_FIRST_NAMES = ["Aarav", "Priya", "Rohan", "Ananya", "Vikram", "Sneha", "Arjun", "Kavya", "Rahul", "Meera", "Karan", "Isha", "Aditya", "Pooja", "Siddharth", "Neha", "Amit", "Divya", "Nikhil", "Riya", "Suresh", "Lakshmi", "Imran", "Fatima", "Harpreet", "Joseph", "Ayesha", "Manoj", "Deepa", "Varun"];
var UXD_LAST_NAMES = ["Sharma", "Iyer", "Patel", "Reddy", "Khan", "Singh", "Nair", "Gupta", "Mehta", "Das", "Joshi", "Menon", "Kulkarni", "Bose", "Verma", "Pillai", "Chopra", "Rao", "Shaikh", "Fernandes"];
var UXD_KNOWN_FIRST = /^(aarav|priya|rohan|ananya|vikram|sneha|arjun|kavya|rahul|meera|karan|isha|aditya|pooja|siddharth|neha|amit|divya|nikhil|riya|suresh|lakshmi|imran|fatima|harpreet|joseph|ayesha|manoj|deepa|varun|john|jane|alex|sam|david|sarah|michael|emma|james|olivia|ravi|anil|sunil|ramesh|raj|vijay|sanjay|arun|anita|sunita|kiran|asha|geeta|sita|mohan|ajay|vivek|gaurav|abhishek|ankit|shreya|nisha|swati|tanvi|zara|user|customer)$/i;
var UXD_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function uxdSeeded(seed) {
  var h = 2166136261;
  for (var i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return function () { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; };
}
function uxdIndianGroup(intText) {
  var s = String(intText);
  if (s.length <= 3) return s;
  var last3 = s.slice(-3), rest = s.slice(0, -3);
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
}
function uxdDigits(rand, count) { var out = ""; for (var i = 0; i < count; i++) out += String(Math.floor(rand() * 10)); return out; }
function uxdFakeValue(text, rand) {
  var t = String(text || "").trim();
  if (!t || t.length > 40) return null;
  var m;
  // Amount in any currency: ₹12,500 · Rs. 4,999.00 · INR 1,20,000 · $1,250.00 · €89 · USD 2,000 · ₹ 85k is left alone.
  // Grouping follows the source: lakh style (1,20,000) for rupees or when the text already uses it, else 1,250,000.
  if ((m = /^([-+]?\s?(?:\p{Sc}|Rs\.?|INR|USD|EUR|GBP|AED|SGD|AUD|CAD|JPY|CHF|R\$)\s?)([\d,]+)(\.\d{1,2})?(\s?(?:\/-|\/mo|\/month|\/yr| per month| per year| p\.m\.))?$/iu.exec(t))) {
    var n = Number(m[2].replace(/,/g, ""));
    if (!isFinite(n) || n <= 0) return null;
    var step = n >= 100000 ? 1000 : n >= 10000 ? 500 : n >= 1000 ? 50 : n >= 100 ? 5 : 1;
    var v = Math.max(step, Math.round((n * (0.45 + rand() * 1.1)) / step) * step);
    var cents = m[3] ? (m[3].length === 3 ? "." + uxdDigits(rand, 2) : m[3]) : "";
    var lakh = /₹|Rs|INR/i.test(m[1]) || /\d,\d{2},\d{3}/.test(m[2]);
    var grouped = m[2].indexOf(",") < 0 && n < 10000 ? String(v) : lakh ? uxdIndianGroup(v) : String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return m[1] + grouped + cents + (m[4] || "");
  }
  // Date: 5 Dec 2026 · 05 Dec · Dec 5, 2026 · 05/12/2026
  if ((m = /^(\d{1,2})(\s)(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(,?\s\d{2,4})?$/i.exec(t))) {
    var day = 1 + Math.floor(rand() * 28);
    return (m[1].length === 2 && day < 10 ? "0" : "") + day + m[2] + UXD_MONTHS[Math.floor(rand() * 12)] + (m[4] || "");
  }
  if ((m = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s(\d{1,2})(,\s?\d{4})?$/i.exec(t))) {
    return UXD_MONTHS[Math.floor(rand() * 12)] + " " + (1 + Math.floor(rand() * 28)) + (m[3] || "");
  }
  if ((m = /^(\d{2})([\/.-])(\d{2})\2(\d{2,4})$/.exec(t))) {
    var dd = 1 + Math.floor(rand() * 28), mm = 1 + Math.floor(rand() * 12);
    return (dd < 10 ? "0" : "") + dd + m[2] + (mm < 10 ? "0" : "") + mm + m[2] + m[4];
  }
  // Masked account / card: XXXX 1234 · •••• 1234 · A/c ****5678 · xx1234
  if ((m = /^(.*?(?:[Xx*•●]{2,}[\s-]?))(\d{4})$/.exec(t))) return m[1] + uxdDigits(rand, 4);
  // PAN
  if (/^[A-Z]{5}\d{4}[A-Z]$/.test(t)) {
    var L = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    var pick = function () { return L[Math.floor(rand() * L.length)]; };
    return pick() + pick() + pick() + "P" + pick() + uxdDigits(rand, 4) + pick();
  }
  // Phone: +91 98765 43210 · 9876543210
  if ((m = /^(\+91[\s-]?)?([6-9])(\d{4})(\s?)(\d{5})$/.exec(t))) return (m[1] || "") + String(6 + Math.floor(rand() * 4)) + uxdDigits(rand, 4) + m[4] + uxdDigits(rand, 5);
  // Reference / loan / txn ID: LN-20481 · TXN982341 · #48213 (prefix kept, same digit count)
  if ((m = /^(#|[A-Z]{2,6}[-\/ ]?)(\d{4,12})$/.exec(t))) return m[1] + uxdDigits(rand, m[2].length).replace(/^0/, String(1 + Math.floor(rand() * 9)));
  // Rate: 10.5% · 12% p.a.
  if ((m = /^(\d{1,2})(\.\d{1,2})?(\s?%)(\s?p\.a\.)?$/i.exec(t))) {
    var rate = Number(m[1] + (m[2] || "")) * (0.75 + rand() * 0.5);
    return (m[2] ? rate.toFixed(m[2].length - 1) : String(Math.max(1, Math.round(rate)))) + m[3] + (m[4] || "");
  }
  // Person name: only when the first word is a known first name, so "Loan Summary" is never a name.
  if ((m = /^([A-Z][a-z]+)(\s[A-Z][a-z]+){1,2}$/.exec(t)) && UXD_KNOWN_FIRST.test(m[1])) {
    return UXD_FIRST_NAMES[Math.floor(rand() * UXD_FIRST_NAMES.length)] + " " + UXD_LAST_NAMES[Math.floor(rand() * UXD_LAST_NAMES.length)];
  }
  return null;
}
// Changing an auto-width text in a free (non auto-layout) parent grows it to the right, which breaks
// right-aligned values and centred labels. Keep the edge the text is anchored to: the right edge for
// text in the right part of its parent (or set to align right), the centre for centred text.
function uxdSetTextKeepAnchor(node, value) {
  var parent = node.parent;
  var free = parent && parent.type !== "PAGE" && (!parent.layoutMode || parent.layoutMode === "NONE" || node.layoutPositioning === "ABSOLUTE");
  var autoWidth = node.textAutoResize === "WIDTH_AND_HEIGHT";
  var anchor = null, x0 = node.x, w0 = node.width;
  if (free && autoWidth && typeof parent.width === "number") {
    var leftGap = x0, rightGap = parent.width - (x0 + w0);
    if (Math.abs(leftGap - rightGap) <= 2 && leftGap > 0) anchor = "center";
    else if (node.textAlignHorizontal === "RIGHT" || rightGap < leftGap) anchor = "right";
  }
  node.characters = value;
  if (anchor === "right") node.x = x0 + w0 - node.width;
  else if (anchor === "center") node.x = x0 + (w0 - node.width) / 2;
}
async function localFillRealisticData(payload) {
  var roots = figma.currentPage.selection.slice();
  if (!roots.length) throw new Error("Select the screen, list or rows to fill first.");
  var texts = [];
  roots.forEach(function (root) {
    if (root.type === "TEXT") texts.push(root);
    else uxdDescendants(root, function (c) { return c.type === "TEXT"; }).forEach(function (t) { texts.push(t); });
  });
  texts = texts.filter(function (t) { return t.visible !== false && t.locked !== true; }).slice(0, 600);
  var plan = [];
  var seen = new Map();
  texts.forEach(function (text) {
    var value = uxdFakeValue(text.characters, uxdSeeded(String(text.id) + "|" + String(payload.seed || "")));
    if (value === null || value === text.characters) return;
    plan.push({ node: text, value: value });
    var key = String(text.characters).trim();
    seen.set(key, (seen.get(key) || 0) + 1);
  });
  for (var f = 0; f < plan.length; f++) { try { await uxdLoadTextFonts(plan[f].node); } catch (_) {} }
  if (typeof figma.commitUndo === "function") figma.commitUndo();
  var changed = 0, samples = [], skipped = 0, edits = [];
  for (var i = 0; i < plan.length; i++) {
    try {
      var before = plan[i].node.characters;
      uxdSetTextKeepAnchor(plan[i].node, plan[i].value);
      changed++;
      edits.push({ id: plan[i].node.id, before: before, after: plan[i].value });
      if (samples.length < 6) samples.push({ before: before, after: plan[i].value });
    } catch (_) { skipped++; }
  }
  if (typeof figma.commitUndo === "function") figma.commitUndo();
  var repeated = 0;
  seen.forEach(function (count) { if (count > 1) repeated += count; });
  var lorem = texts.filter(function (t) { return /lorem ipsum|dolor sit amet/i.test(t.characters); }).length;
  return { ok: true, checked: texts.length, changed: changed, repeated: repeated, skipped: skipped, samples: samples, lorem: lorem, edits: edits };
}
// Snapshot revert: put each text back only if it still shows what UX Direct wrote, so a revert works
// after unrelated Figma edits (Figma undo would pop whatever happened last) and never clobbers a
// designer's own later change.
async function localRestoreTexts(payload) {
  var items = Array.isArray(payload.edits) ? payload.edits.slice(0, 800) : [];
  var restored = 0, changedSince = 0, missing = 0;
  if (typeof figma.commitUndo === "function") figma.commitUndo();
  for (var i = 0; i < items.length; i++) {
    var node = await figma.getNodeByIdAsync(String(items[i].id || ""));
    if (!node || node.type !== "TEXT" || node.removed) { missing++; continue; }
    if (node.characters !== String(items[i].expect)) { changedSince++; continue; }
    try { await uxdLoadTextFonts(node); uxdSetTextKeepAnchor(node, String(items[i].text)); restored++; } catch (_) { missing++; }
  }
  if (typeof figma.commitUndo === "function") figma.commitUndo();
  return { ok: true, restored: restored, changedSince: changedSince, missing: missing };
}
// uxd-fill-data:end
// uxd-consistency:start
// Style lock across screens, no model: the same element (same layer name) on 2+ selected screens should
// look the same, and the same button label should be written the same way. Reports drift; "fix" sets
// each drifted layer to the most common value (property snapshot, so Revert restores exactly).
var UXD_GENERIC_NAME = /^(frame|group|rectangle|ellipse|vector|auto layout|container|component|instance|text|line|image|section|layer)\b/i;
function uxdConsistencyKey(name) {
  var base = String(name || "").split(/\s+[·•|\/–—-]\s+/)[0].replace(/\s*\d+$/, "").trim().toLowerCase();
  return base && !UXD_GENERIC_NAME.test(base) && base.length <= 40 ? base : "";
}
function uxdFillHex(node) {
  if (!Array.isArray(node.fills) || node.fills.length !== 1 || (node.fillStyleId && typeof node.fillStyleId === "string")) return null;
  var p = node.fills[0];
  if (!p || p.type !== "SOLID" || p.visible === false || (p.boundVariables && p.boundVariables.color)) return null;
  function h(v) { return ("0" + Math.round(v * 255).toString(16)).slice(-2); }
  return ("#" + h(p.color.r) + h(p.color.g) + h(p.color.b)).toUpperCase() + (p.opacity !== undefined && p.opacity < 1 ? "@" + Math.round(p.opacity * 100) : "");
}
var UXD_CONSISTENCY_PROPS = {
  radius: { read: function (n) { return typeof n.cornerRadius === "number" ? String(n.cornerRadius) : null; }, props: ["cornerRadius"] },
  padding: { read: function (n) { return n.layoutMode && n.layoutMode !== "NONE" ? [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].join("/") : null; },
    props: ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] },
  gap: { read: function (n) { return n.layoutMode && n.layoutMode !== "NONE" && n.primaryAxisAlignItems !== "SPACE_BETWEEN" ? String(n.itemSpacing) : null; }, props: ["itemSpacing"] },
  fill: { read: uxdFillHex, props: ["fills"] },
};
async function localConsistency(payload) {
  var roots = figma.currentPage.selection.filter(function (n) { return ["FRAME", "COMPONENT", "SECTION"].indexOf(n.type) >= 0; });
  if (!roots.length) throw new Error("Select the screens to compare (style lock works across screens, or inside one screen).");
  roots = roots.slice(0, 12);
  var fix = payload && payload.fix === true;
  var groups = {}, labels = {};
  roots.forEach(function (root, r) {
    var slots = {};
    uxdDescendants(root, function (c) { return c.visible !== false; }).forEach(function (node) {
      if (node.locked === true) return;
      // Instances count too (a "Loan Card" instance can carry radius/padding overrides), and so do layers inside them.
      if ((node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") && !(node.width > 400 && node.height > 400)) {
        var key = uxdConsistencyKey(node.name);
        if (!key) return;
        // Across screens the Nth "Loan card" is compared with the Nth one on the other screens, so a
        // featured first card is not flattened to look like the cards under it.
        var slot = slots[key] = (slots[key] || 0) + 1;
        var groupKey = roots.length > 1 ? key + "#" + slot : key;
        (groups[groupKey] = groups[groupKey] || []).push({ node: node, root: r, slot: slot });
      }
      if (node.type === "TEXT" && node.parent && (UXD_BUTTON_NAME.test(String(node.parent.name || "")) || UXD_BUTTON_NAME.test(String(node.name || "")) || uxdLooksLikeButton(node.parent))) {
        var text = String(node.characters || "").trim();
        var norm = text.toLowerCase().replace(/[.!…]+$/, "").replace(/\s+/g, " ");
        if (norm && norm.length <= 40) (labels[norm] = labels[norm] || []).push({ node: node, root: r, text: text });
      }
    });
  });
  var findings = [], changes = [];
  function majority(entries, readFn) {
    var counts = {}, order = [];
    entries.forEach(function (e) { var v = readFn(e); if (v === null || v === undefined) return; if (!counts[v]) { counts[v] = 0; order.push(v); } counts[v]++; });
    var best = order.reduce(function (a, b) { return counts[b] > counts[a] ? b : a; }, order[0]);
    return { counts: counts, values: order, best: best };
  }
  Object.keys(groups).forEach(function (key) {
    var entries = groups[key];
    var screens = {}; entries.forEach(function (e) { screens[e.root] = 1; });
    // Across 2+ screens an element must appear on 2 of them; on one screen, 2 copies of it are enough.
    if (roots.length > 1 ? Object.keys(screens).length < 2 : entries.length < 2) return;
    Object.keys(UXD_CONSISTENCY_PROPS).forEach(function (kind) {
      var spec = UXD_CONSISTENCY_PROPS[kind];
      var m = majority(entries, function (e) { return spec.read(e.node); });
      if (m.values.length < 2) return;
      var odd = entries.filter(function (e) { var v = spec.read(e.node); return v !== null && v !== m.best; });
      var baseName = entries[0].node.name.split(/\s+[·•|\/–—-]\s+/)[0];
      var multiSlot = roots.length > 1 && (entries[0].slot > 1 || groups[key.replace(/#\d+$/, "") + "#2"]);
      findings.push({ element: multiSlot ? baseName + " #" + entries[0].slot : baseName, kind: kind, expected: m.best,
        found: m.values.filter(function (v) { return v !== m.best; }), layers: odd.length,
        screens: odd.map(function (e) { return roots[e.root].name; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).slice(0, 4) });
      if (fix) {
        var model = entries.find(function (e) { return spec.read(e.node) === m.best; }).node;
        odd.forEach(function (e) { changes.push({ node: e.node, props: spec.props, model: model }); });
      }
    });
  });
  Object.keys(labels).forEach(function (norm) {
    var entries = labels[norm];
    var m = majority(entries, function (e) { return e.text; });
    if (m.values.length < 2) return;
    var odd = entries.filter(function (e) { return e.text !== m.best; });
    findings.push({ element: "Button label", kind: "label", expected: m.best, found: m.values.filter(function (v) { return v !== m.best; }), layers: odd.length,
      screens: odd.map(function (e) { return roots[e.root].name; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).slice(0, 4) });
    if (fix) odd.forEach(function (e) { changes.push({ node: e.node, props: ["characters"], text: m.best }); });
  });
  var snapshot = [];
  if (fix && changes.length) {
    if (typeof figma.commitUndo === "function") figma.commitUndo();
    UXD_HYGIENE_SNAPSHOT = { keys: {}, items: [] };
    for (var i = 0; i < changes.length && i < 400; i++) {
      var ch = changes[i];
      try {
        ch.props.forEach(function (prop) { uxdSnapProp(ch.node, prop); });
        if (ch.text !== undefined) { await uxdLoadTextFonts(ch.node); ch.node.characters = ch.text; }
        else ch.props.forEach(function (prop) { ch.node[prop] = uxdCloneValue(ch.model[prop]); });
      } catch (_) {}
    }
    snapshot = UXD_HYGIENE_SNAPSHOT.items.map(function (item) {
      var after = uxdCloneValue(item.node[item.prop]);
      return { id: item.node.id, prop: item.prop, before: item.before, after: after === undefined ? null : after };
    }).filter(function (item) { return JSON.stringify(item.before) !== JSON.stringify(item.after); });
    UXD_HYGIENE_SNAPSHOT = null;
    if (typeof figma.commitUndo === "function") figma.commitUndo();
  }
  findings.sort(function (a, b) { return b.layers - a.layers; });
  return { ok: true, screens: roots.map(function (r) { return r.name; }), findings: findings.slice(0, 40), fixed: snapshot.length, snapshot: snapshot };
}
// uxd-consistency:end
// uxd-design-rules:start
// Per-file design rules ("DESIGN.md"): stored in the Figma file itself, so everyone on the file shares
// them. The UI parses the designer's text into {spacing, radii, typeScale, minText, colors, font, tone};
// the hygiene fixer snaps to the file's own scales instead of the generic 4px grid.
var UXD_ACTIVE_RULES = null;
function uxdNearest(list, value) {
  return list.reduce(function (best, v) { return Math.abs(v - value) < Math.abs(best - value) ? v : best; }, list[0]);
}
function uxdReadDesignRules() {
  var text = "", rules = null;
  try { text = figma.root.getPluginData("uxdDesignRulesText") || ""; } catch (_) {}
  try { var raw = figma.root.getPluginData("uxdDesignRules"); rules = raw ? JSON.parse(raw) : null; } catch (_) { rules = null; }
  return { text: text, rules: rules };
}
async function localGetDesignRules() {
  var current = uxdReadDesignRules();
  return { ok: true, text: current.text, rules: current.rules };
}
async function localSetDesignRules(payload) {
  var text = typeof payload.text === "string" ? payload.text.slice(0, 4000) : "";
  var rules = payload.rules && typeof payload.rules === "object" ? payload.rules : null;
  var previous = uxdReadDesignRules();
  figma.root.setPluginData("uxdDesignRulesText", text);
  figma.root.setPluginData("uxdDesignRules", rules ? JSON.stringify(rules).slice(0, 8000) : "");
  return { ok: true, previous: previous };
}
// uxd-design-rules:end
// uxd-section-edit:start
// Section edit on the native action planner: a property state of the selected subtrees before and
// after the plan, so Revert restores exactly what the plan changed (restore-props + delete-created),
// and a fingerprint of the layers next to the selection, which must stay identical.
var UXD_SECTION_PROPS = UXD_DIRECT_SNAP_PROPS.concat(["characters", "visible", "name", "width", "height", "rotation",
  "layoutSizingHorizontal", "layoutSizingVertical", "layoutGrow", "layoutPositioning", "primaryAxisSizingMode", "counterAxisSizingMode",
  "textAutoResize", "clipsContent", "strokeAlign", "constraints", "layoutGrids", "fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId",
  "minWidth", "maxWidth", "minHeight", "maxHeight", "counterAxisSpacing"]);
function uxdSectionWalk(root, visit, limit) {
  var count = 0;
  (function walk(n) {
    if (count >= limit || !n || n.removed) return;
    count++; visit(n);
    (n.children || []).forEach(walk);
  })(root);
  return count;
}
function uxdNodeState(node) {
  var state = {};
  UXD_SECTION_PROPS.forEach(function (prop) {
    if (!(prop in node)) return;
    var value = uxdCloneValue(node[prop]);
    if (value !== undefined) state[prop] = value;
  });
  return state;
}
function uxdHashString(text) {
  var h = 2166136261;
  for (var i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
async function localSectionState(payload) {
  var ids = Array.isArray(payload.rootIds) ? payload.rootIds.slice(0, 12) : [];
  var nodes = {}, order = [], created = [], siblings = {}, truncated = false;
  var rootSet = {};
  ids.forEach(function (id) { rootSet[String(id)] = true; });
  for (var i = 0; i < ids.length; i++) {
    var root = await figma.getNodeByIdAsync(String(ids[i]));
    if (!root || root.removed) continue;
    var seen = uxdSectionWalk(root, function (n) {
      nodes[n.id] = uxdNodeState(n);
      order.push(n.id);
      if (typeof n.getPluginData === "function" && n.getPluginData("uxdCreated") === "1") created.push({ id: n.id, parentId: n.parent ? n.parent.id : "" });
    }, 1500);
    if (seen >= 1500) truncated = true;
    var parent = root.parent;
    if (!parent || parent.type === "PAGE" || parent.type === "DOCUMENT") continue;
    (parent.children || []).forEach(function (sib) {
      if (rootSet[sib.id] || siblings[sib.id]) return;
      var parts = [];
      uxdSectionWalk(sib, function (n) { parts.push(n.id + ":" + JSON.stringify(uxdNodeState(n))); }, 1500);
      siblings[sib.id] = { name: sib.name, hash: uxdHashString(parts.join("|")) };
    });
  }
  return { ok: true, nodes: nodes, order: order, created: created, siblings: siblings, truncated: truncated };
}
// uxd-section-edit:end
// uxd-icons:start
// Real icons (Lucide via Iconify, resolved by the backend) as native vector layers. No model involved.
// "find-icon-targets" lists buttons/rows without an icon so the UI can pick icons by label;
// "insert-icons" adds each SVG before the label (auto layout) or swaps a selected icon in place.
// Every created layer is tagged uxdCreated, and a replaced icon is only hidden, so Revert is exact.
var UXD_ICON_NAME = /\b(icon|ic|glyph|chevron|arrow|svg)\b/i;
function uxdIsIconLike(node) {
  if (!node || node.removed) return false;
  if (["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "POLYGON"].indexOf(node.type) >= 0) return Math.max(node.width || 0, node.height || 0) <= 64;
  if (["FRAME", "GROUP", "INSTANCE", "COMPONENT"].indexOf(node.type) < 0) return false;
  var w = node.width || 0, h = node.height || 0;
  if (w > 64 || h > 64 || w < 8 || h < 8 || Math.abs(w - h) > Math.max(w, h) * 0.25) return false;
  if (UXD_ICON_NAME.test(String(node.name || ""))) return true;
  var kids = uxdDescendants(node, function () { return true; });
  return kids.length > 0 && kids.every(function (c) { return ["VECTOR", "BOOLEAN_OPERATION", "GROUP", "FRAME", "ELLIPSE", "RECTANGLE", "LINE", "POLYGON", "STAR"].indexOf(c.type) >= 0; });
}
function uxdInsideInstance(node) {
  for (var p = node.parent; p && p.type !== "PAGE"; p = p.parent) if (p.type === "INSTANCE") return true;
  return false;
}
function uxdIsDataValueText(text) {
  var value = String(text.characters || "").trim();
  return /[0-9₹$€£¥%]/.test(value) && !/^(step|page)\s*\d/i.test(value);
}
// One text holding both label and value ("EMI  ₹9,450", "Next due  05 Dec"): the label is the part
// before the value (split at a wide gap, or at the first digit or currency sign).
function uxdLabelPart(text) {
  var value = String(text && text.characters || "").trim();
  var parts = value.split(/\s{2,}|\t|\s[·:|–—-]\s/);
  var head = parts.length > 1 ? parts[0] : value.split(/\s+(?=(?:Rs\.?|INR|USD|EUR|GBP|AED|SGD)\s|\S*[0-9\p{Sc}])/u)[0];
  head = String(head || "").replace(/[\s:·|–—-]+$/, "").trim();
  return head.length >= 2 && head.length <= 30 && /\p{L}{2}/u.test(head) && !/[0-9\p{Sc}%]/u.test(head) && head !== value ? head : "";
}
// What kind of value a row shows, so a row whose label names no icon still gets a fitting one.
function uxdValueKind(texts) {
  var all = texts.map(function (t) { return String(t.characters || ""); }).join("  ");
  if (/\p{Sc}\s?\d|\b(?:Rs\.?|INR|USD|EUR|GBP|AED|SGD|AUD|CAD|JPY|CHF)\s?\d/u.test(all)) return "currency";
  if (/\d\s?%/.test(all)) return "percent";
  if (/\b\d{1,2}\s(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s\d{1,2}\b|\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/i.test(all)) return "date";
  if (/\b\d{1,2}:\d{2}\s?(?:am|pm)?\b/i.test(all)) return "time";
  return null;
}
function uxdIconTargetInfo(node) {
  if (["FRAME", "COMPONENT"].indexOf(node.type) < 0 || node.visible === false || node.locked === true) return null;
  if ((node.height || 0) > 88 || (node.width || 0) < 40 || uxdInsideInstance(node)) return null;
  var kids = (node.children || []).filter(function (c) { return c.visible !== false; });
  var texts = kids.filter(function (c) { return c.type === "TEXT"; });
  if (!texts.length || texts.length > 2 || kids.some(uxdIsIconLike)) return null;
  // A row's label is its first non-value text ("Due" in "Due  ₹1,00,000"), whatever the layer order.
  // Only values here (e.g. "Row · Due" holds "₹1,00,000" directly, its label sits in a nested
  // "Row text" frame): not a target by itself; uxdNestedRowTarget reads the nested label instead.
  var labelText = texts.find(function (t) { return !uxdIsDataValueText(t); });
  var mixed = labelText ? null : texts.find(function (t) { return uxdLabelPart(t); });
  if (!labelText && !mixed) return null;
  if (!labelText) labelText = mixed;
  var label = uxdLabelPart(labelText) || String(labelText.characters || "").trim();
  if (!label || label.length > 40) return null;
  var size = typeof labelText.fontSize === "number" ? labelText.fontSize : 14;
  // Data rows ("Balance  ₹12,400", "Due date  12 Nov") show a value, not an action: flagged, and only
  // used when the row itself is selected.
  return { id: node.id, name: node.name, label: label, fontSize: size, button: uxdIsButtonLike(node, texts), data: texts.some(uxdIsDataValueText), valueKind: uxdValueKind(texts) };
}
// A button: named like one, or a filled/outlined rounded box of 24–64px holding one label.
// Data rows ("Row · Loan Amount": label + value, no box) are not buttons.
var UXD_BUTTON_NAME = /\b(button|btn|cta)\b/i;
function uxdIsButtonLike(node, texts) {
  if (UXD_BUTTON_NAME.test(String(node.name || ""))) return true;
  if (/\brow\b/i.test(String(node.name || "")) || texts.length !== 1) return false;
  var h = node.height || 0;
  if (h < 24 || h > 64) return false;
  function visiblePaint(list) { return Array.isArray(list) && list.some(function (p) { return p && p.visible !== false && (p.opacity === undefined || p.opacity > 0); }); }
  var boxed = visiblePaint(node.fills) || visiblePaint(node.strokes);
  var radius = typeof node.cornerRadius === "number" ? node.cornerRadius : (node.topLeftRadius || 0);
  return boxed && (radius > 0 || node.cornerRadius === figma.mixed);
}
// A directly selected row whose texts sit in nested frames ("Row · Due" > "Row text" > label + value,
// plus a status badge): the row itself is the target, labelled by its first non-value text outside badges.
function uxdNestedRowTarget(node) {
  if (["FRAME", "COMPONENT"].indexOf(node.type) < 0 || node.visible === false || node.locked === true) return null;
  if ((node.height || 0) > 88 || (node.width || 0) < 40 || uxdInsideInstance(node)) return null;
  if ((node.children || []).some(uxdIsIconLike)) return null;
  var texts = uxdDescendants(node, function (c) { return c.type === "TEXT" && c.visible !== false; }).filter(function (t) {
    for (var p = t.parent; p && p !== node; p = p.parent) if (/\b(badge|chip|tag|status|pill)\b/i.test(String(p.name || "")) || p.type === "INSTANCE") return false;
    return true;
  });
  var labelText = texts.find(function (t) { return !uxdIsDataValueText(t) && String(t.characters || "").trim(); });
  var mixed = labelText ? null : texts.find(function (t) { return uxdLabelPart(t); });
  if (!labelText && !mixed) return null;
  if (!labelText) labelText = mixed;
  var label = uxdLabelPart(labelText) || String(labelText.characters).trim();
  if (label.length > 40) return null;
  return { id: node.id, name: node.name, label: label, fontSize: typeof labelText.fontSize === "number" ? labelText.fontSize : 14, button: false, data: true, valueKind: uxdValueKind(texts) };
}
async function localFindIconTargets(payload) {
  var roots = figma.currentPage.selection.slice();
  if (!roots.length) throw new Error("Select the buttons, rows or screen that need icons.");
  var out = [], seen = {};
  function add(info, nested) { if (info && !seen[info.id] && out.length < 40) { seen[info.id] = 1; info.selected = !nested; out.push(info); } }
  roots.forEach(function (root) {
    var self = uxdIconTargetInfo(root) || uxdNestedRowTarget(root);
    if (self) { add(self, false); return; }
    if (root.type === "INSTANCE") return;
    uxdDescendants(root, function (c) { return c.type === "FRAME" || c.type === "COMPONENT"; }).forEach(function (c) {
      var info = uxdIconTargetInfo(c);
      if (info && (!info.data || (payload && payload.rows === true))) add(info, true);
    });
  });
  // Inside a selected screen, icons go on buttons only; rows are used only when the selection
  // has no button at all (e.g. a selected list). A directly selected row still counts.
  var buttons = out.filter(function (t) { return t.button || t.selected; });
  if (!(payload && payload.rows === true) && buttons.some(function (t) { return t.button; })) out = buttons;
  return { ok: true, targets: out.slice(0, 20) };
}
function uxdIconColor(target) {
  var sources = target.type === "TEXT" ? [target] : uxdDescendants(target, function (c) { return c.type === "TEXT" && c.visible !== false; });
  if (uxdIsIconLike(target)) sources = uxdDescendants(target, function (c) { return c.type !== "GROUP" && c.type !== "FRAME"; }).concat(sources);
  for (var i = 0; i < sources.length; i++) {
    var lists = [sources[i].strokes, sources[i].fills];
    for (var j = 0; j < lists.length; j++) {
      if (!Array.isArray(lists[j])) continue;
      var solid = lists[j].find(function (p) { return p && p.type === "SOLID" && p.visible !== false; });
      if (solid) return { r: solid.color.r, g: solid.color.g, b: solid.color.b };
    }
  }
  return { r: 0.12, g: 0.16, b: 0.22 };
}
function uxdIconSize(target, requested) {
  if (requested) return requested;
  var text = target.type === "TEXT" ? target : (target.children || []).find(function (c) { return c.type === "TEXT"; });
  var fs = text && typeof text.fontSize === "number" ? text.fontSize : 16;
  return fs <= 13 ? 16 : fs <= 16 ? 20 : 24;
}
function uxdPaintIcon(icon, color) {
  uxdDescendants(icon, function (c) { return c.type !== "FRAME" && c.type !== "GROUP"; }).forEach(function (v) {
    try {
      if (Array.isArray(v.strokes) && v.strokes.length) v.strokes = [{ type: "SOLID", color: color }];
      if (Array.isArray(v.fills) && v.fills.length) v.fills = [{ type: "SOLID", color: color }];
    } catch (_) {}
  });
}
function uxdSiblingLeadingBox(target) {
  var parent = target.parent;
  if (!parent || !parent.children) return null;
  for (var i = 0; i < parent.children.length; i++) {
    var sib = parent.children[i];
    if (sib === target || sib.visible === false || !sib.children || !sib.children.length) continue;
    var lead = sib.children[0];
    if (lead.type === "FRAME" && /\bleading\b/i.test(String(lead.name || "")) && lead.width <= 64 && lead.height <= 64 && typeof lead.clone === "function") return lead;
  }
  return null;
}
async function localInsertIcons(payload) {
  var items = Array.isArray(payload.items) ? payload.items.slice(0, 20) : [];
  var inserted = [], skipped = [], created = [], hidden = [];
  if (typeof figma.commitUndo === "function") figma.commitUndo();
  for (var i = 0; i < items.length; i++) {
    var item = items[i] || {};
    var target = await figma.getNodeByIdAsync(String(item.targetId || ""));
    if (!target || target.removed) { skipped.push({ id: item.targetId, reason: "layer no longer exists" }); continue; }
    if (typeof item.svg !== "string" || item.svg.indexOf("<svg") !== 0) { skipped.push({ id: target.id, name: target.name, reason: "no icon found" }); continue; }
    var replace = uxdIsIconLike(target);
    var holder = replace ? target.parent : target;
    if (!holder || holder.type === "INSTANCE" || uxdInsideInstance(target) || (!replace && target.type === "INSTANCE")) {
      skipped.push({ id: target.id, name: target.name, reason: "inside a component instance; change the icon in the main component" });
      continue;
    }
    if (!replace && ["FRAME", "COMPONENT"].indexOf(target.type) < 0) {
      skipped.push({ id: target.id, name: target.name, reason: "select a frame, button or icon" });
      continue;
    }
    var size = replace ? Math.round(Math.max(target.width, target.height)) : uxdIconSize(target, Number(item.size) || 0);
    var color = uxdIconColor(target);
    var icon;
    try { icon = figma.createNodeFromSvg(item.svg); } catch (error) { skipped.push({ id: target.id, name: target.name, reason: "SVG could not be imported" }); continue; }
    icon.name = "Icon / " + String(item.name || "icon").slice(0, 40);
    try { icon.fills = []; } catch (_) {}
    if (icon.width && Math.abs(icon.width - size) > 0.5 && typeof icon.rescale === "function") icon.rescale(size / icon.width);
    else if (typeof icon.resize === "function") icon.resize(size, size);
    uxdPaintIcon(icon, color);
    if (typeof icon.setPluginData === "function") icon.setPluginData("uxdCreated", "1");
    if (replace) {
      var index = holder.children.indexOf(target);
      holder.insertChild(index + 1, icon);
      if (!uxdHasAutoLayout(holder) || target.layoutPositioning === "ABSOLUTE") {
        if (target.layoutPositioning === "ABSOLUTE") icon.layoutPositioning = "ABSOLUTE";
        icon.x = target.x + (target.width - size) / 2; icon.y = target.y + (target.height - size) / 2;
      }
      hidden.push({ id: target.id, prop: "visible", before: target.visible !== false, after: false });
      target.visible = false;
    } else if (uxdHasAutoLayout(target)) {
      // Sibling rows that put their icon in a "Leading" box (circle background) get the same box here.
      var leadBox = uxdSiblingLeadingBox(target);
      if (leadBox) {
        var box = leadBox.clone();
        (box.children || []).slice().forEach(function (c) { c.remove(); });
        box.name = "Leading / " + String(item.name || "icon").slice(0, 40);
        var fit = Math.min(size, Math.round(Math.min(box.width, box.height) * 0.6));
        if (fit !== size && typeof icon.rescale === "function" && icon.width) icon.rescale(fit / icon.width);
        box.appendChild(icon);
        if (!uxdHasAutoLayout(box)) { icon.x = Math.round((box.width - icon.width) / 2); icon.y = Math.round((box.height - icon.height) / 2); }
        if (typeof box.setPluginData === "function") box.setPluginData("uxdCreated", "1");
        target.insertChild(0, box);
        icon = box;
      } else target.insertChild(0, icon);
      if (target.layoutMode === "HORIZONTAL" && (Number(target.itemSpacing) || 0) < 4 && target.primaryAxisAlignItems !== "SPACE_BETWEEN") {
        // The icon must not touch its label.
        var gap = size <= 16 ? 6 : 8;
        hidden.push({ id: target.id, prop: "itemSpacing", before: target.itemSpacing, after: gap });
        target.itemSpacing = gap;
      }
      if (target.counterAxisAlignItems === "MIN" && target.layoutMode === "HORIZONTAL") {
        hidden.push({ id: target.id, prop: "counterAxisAlignItems", before: "MIN", after: "CENTER" });
        target.counterAxisAlignItems = "CENTER";
      }
    } else {
      var first = (target.children || []).filter(function (c) { return c.visible !== false; }).reduce(function (min, c) { return Math.min(min, c.x); }, Infinity);
      if (first < size + 16) {
        // Make room: shift the row's content right by the missing space when it still fits in the row.
        var kids = (target.children || []).filter(function (c) { return c.visible !== false; });
        // The icon takes the label's old spot, so the row keeps its left margin.
        var shift = size + 8;
        var right = kids.reduce(function (max, c) { return Math.max(max, c.x + c.width); }, 0);
        if (!kids.length || right + shift > target.width - 8 || kids.some(function (c) { return c.locked === true; })) {
          icon.remove(); skipped.push({ id: target.id, name: target.name, reason: "no room before the label, and the row is too full to shift its content" }); continue;
        }
        kids.forEach(function (c) { hidden.push({ id: c.id, prop: "x", before: c.x, after: c.x + shift }); c.x = c.x + shift; });
        first += shift;
      }
      target.appendChild(icon);
      icon.x = Math.max(8, first - size - 8); icon.y = Math.round((target.height - size) / 2);
    }
    created.push(icon.id);
    inserted.push({ id: icon.id, icon: String(item.name || ""), target: target.name, mode: replace ? "replaced" : "added", size: size });
  }
  if (typeof figma.commitUndo === "function") figma.commitUndo();
  return { ok: true, inserted: inserted, skipped: skipped, createdIds: created, restore: hidden };
}
// uxd-icons:end
// uxd-handoff:start
// Developer handoff, no model. "add handoff notes" puts native Figma annotations (visible in Dev Mode)
// on the screen, buttons, inputs and cards: measured specs as annotation properties plus the states a
// developer must build. "wire the prototype" links buttons across 2+ screens by label (Back -> back,
// "Pay now" -> the "Pay" screen, Continue/Next -> the next screen left to right). Both snapshot the
// property they change, so Revert is exact, and neither touches layers that already have their own.
var UXD_HANDOFF_PREFIX = "Handoff · ";
var UXD_INPUT_NAME = /\b(input|field|text ?field|search ?bar|textbox|dropdown|select)\b/i;
var UXD_CARD_NAME = /\b(card|tile|list ?item|row|cell)\b/i;
function uxdFirstText(node) {
  if (node.type === "TEXT") return String(node.characters || "").trim();
  var t = uxdDescendants(node, function (n) { return n.type === "TEXT" && n.visible !== false && String(n.characters || "").trim(); })[0];
  return t ? String(t.characters).trim() : "";
}
// Figma reads annotations back with both label and labelMarkdown, but refuses both on write.
function uxdCleanAnnotations(list) {
  return (Array.isArray(list) ? list : []).map(function (a) {
    var out = {};
    if (a && a.labelMarkdown) out.labelMarkdown = String(a.labelMarkdown);
    else if (a && a.label) out.label = String(a.label);
    if (a && Array.isArray(a.properties) && a.properties.length) out.properties = a.properties.map(function (p) { return { type: p.type }; });
    if (a && a.categoryId) out.categoryId = a.categoryId;
    return out;
  }).filter(function (a) { return a.labelMarkdown || a.label || a.properties; });
}
// A button is either named like one, or looks like one: a small frame holding exactly one short label,
// with a fill, stroke or rounded corners (or a Back/Continue-style label), e.g. "Frame 4" > "Pay now".
function uxdLooksLikeButton(node) {
  if (node.type !== "FRAME" && node.type !== "INSTANCE" && node.type !== "COMPONENT") return false;
  if (UXD_BUTTON_NAME.test(String(node.name || ""))) return true;
  if (UXD_INPUT_NAME.test(String(node.name || "")) || UXD_CARD_NAME.test(String(node.name || ""))) return false;
  if (!(node.height >= 24 && node.height <= 72 && node.width <= 360) || (node.children || []).length > 3) return false;
  var texts = uxdDescendants(node, function (n) { return n.type === "TEXT" && n.visible !== false && String(n.characters || "").trim(); });
  if (texts.length !== 1) return false;
  var label = String(texts[0].characters).trim();
  if (label.length > 24 || label.split(/\s+/).length > 4 || !/\p{L}/u.test(label)) return false;
  var painted = function (list) { return Array.isArray(list) && list.some(function (p) { return p && p.visible !== false && (p.opacity === undefined || p.opacity > 0); }); };
  return painted(node.fills) || painted(node.strokes) || (typeof node.cornerRadius === "number" && node.cornerRadius > 0) ||
    UXD_BACK_LABEL.test(label) || UXD_NEXT_LABEL.test(label) || UXD_SKIP_LABEL.test(label);
}
function uxdHandoffKind(node) {
  if (node.type !== "FRAME" && node.type !== "INSTANCE" && node.type !== "COMPONENT") return "";
  var name = String(node.name || "");
  if (UXD_BUTTON_NAME.test(name)) return "button";
  if (UXD_INPUT_NAME.test(name)) return "input";
  if (UXD_CARD_NAME.test(name)) return "card";
  return uxdLooksLikeButton(node) ? "button" : "";
}
function uxdHandoffNote(node, kind, root) {
  var label = uxdFirstText(node).slice(0, 40);
  var w = Math.round(node.width), h = Math.round(node.height);
  if (node === root) return { text: UXD_HANDOFF_PREFIX + "Screen \"" + node.name + "\", " + w + "×" + h + ". Build top to bottom; spacing and colours are on each annotated layer.",
    props: ["width", "height"] };
  if (kind === "button") return { text: UXD_HANDOFF_PREFIX + "Button \"" + label + "\". States: default, pressed, disabled, loading." +
    (h < 44 ? " Height is " + h + "px; keep the tap area at least 44px." : ""), props: ["width", "height", "cornerRadius", "fills", "padding"] };
  if (kind === "input") return { text: UXD_HANDOFF_PREFIX + "Input \"" + label + "\". States: empty, focused, filled, error (message below the field), disabled.",
    props: ["width", "height", "cornerRadius", "strokes", "padding"] };
  return { text: UXD_HANDOFF_PREFIX + node.name.split(/\s+[·•|\/–—-]\s+/)[0] + ". Long text truncates to 1 line; values come from data, format as shown.",
    props: ["width", "cornerRadius", "fills", "padding", "itemSpacing"] };
}
function uxdHandoffProps(node, props) {
  return props.filter(function (type) {
    if (type === "padding") return node.layoutMode && node.layoutMode !== "NONE";
    if (type === "itemSpacing") return node.layoutMode && node.layoutMode !== "NONE";
    if (type === "cornerRadius") return typeof node.cornerRadius === "number" && node.cornerRadius > 0;
    if (type === "fills") return Array.isArray(node.fills) && node.fills.length > 0;
    if (type === "strokes") return Array.isArray(node.strokes) && node.strokes.length > 0;
    return true;
  }).map(function (type) { return { type: type }; });
}
async function localHandoffNotes() {
  var roots = figma.currentPage.selection.filter(function (n) { return ["FRAME", "COMPONENT", "INSTANCE"].indexOf(n.type) >= 0; }).slice(0, 8);
  if (!roots.length) throw new Error("Select a screen to add handoff notes.");
  if (typeof figma.commitUndo === "function") figma.commitUndo();
  UXD_HYGIENE_SNAPSHOT = { keys: {}, items: [] };
  var notes = [], skipped = 0;
  roots.forEach(function (root) {
    var targets = [{ node: root, kind: "screen" }];
    uxdDescendants(root, function (n) { return n.visible !== false; }).forEach(function (n) {
      if (targets.length >= 40) return;
      var kind = uxdHandoffKind(n);
      if (!kind) return;
      for (var p = n.parent; p && p !== root; p = p.parent) if (uxdHandoffKind(p) === kind) return;
      targets.push({ node: n, kind: kind });
    });
    targets.forEach(function (t) {
      var node = t.node;
      if (!("annotations" in node)) { skipped++; return; }
      var note = uxdHandoffNote(node, t.kind, root);
      var keep = uxdCleanAnnotations(node.annotations).filter(function (a) { return String(a.labelMarkdown || a.label || "").indexOf(UXD_HANDOFF_PREFIX) !== 0; });
      // Revert goes back to the designer's own notes only, even after several runs.
      if (UXD_HYGIENE_SNAPSHOT && !UXD_HYGIENE_SNAPSHOT.keys[node.id + "|annotations"]) {
        UXD_HYGIENE_SNAPSHOT.keys[node.id + "|annotations"] = true;
        UXD_HYGIENE_SNAPSHOT.items.push({ node: node, prop: "annotations", before: keep });
      }
      try { node.annotations = keep.concat([{ labelMarkdown: note.text, properties: uxdHandoffProps(node, note.props) }]); }
      catch (_) {
        try { node.annotations = keep.concat([{ labelMarkdown: note.text }]); } catch (__) { skipped++; return; }
      }
      notes.push({ id: node.id, kind: t.kind, name: node.name, note: note.text.slice(UXD_HANDOFF_PREFIX.length, UXD_HANDOFF_PREFIX.length + 120) });
    });
  });
  var snapshot = UXD_HYGIENE_SNAPSHOT.items.map(function (item) {
    var after = uxdCloneValue(item.node[item.prop]);
    return { id: item.node.id, prop: item.prop, before: item.before, after: after === undefined ? null : after };
  });
  UXD_HYGIENE_SNAPSHOT = null;
  if (typeof figma.commitUndo === "function") figma.commitUndo();
  return { ok: true, notes: notes, skipped: skipped, snapshot: snapshot };
}
var UXD_BACK_LABEL = /^(back|go back|previous|prev|cancel|close|dismiss|wapas|peeche|piche)\b/i;
var UXD_NEXT_LABEL = /\b(continue|next|proceed|submit|confirm|get started|sign ?in|log ?in|sign ?up|verify|done|finish|start|got it|aage|save)\b/i;
// "Skip" in a carousel/onboarding skips the whole run: it goes to the first later screen that has no Skip itself.
var UXD_SKIP_LABEL = /^(skip|skip for now|skip all|skip intro)\b/i;
// A failed step's Retry goes back to the step that failed; "Home" from the end goes to the start.
var UXD_RETRY_LABEL = /^(retry|try again|try once more|dobara)\b/i;
var UXD_HOME_LABEL = /\b(home|dashboard|back to (home|start)|go to home|close)\b/i;
// A layer that is a back control by itself: an app bar's back arrow icon (no label).
var UXD_BACK_ICON = /\b(back|arrow[ _-]?left|chevron[ _-]?left|caret[ _-]?left|nav(igation)?[ _-]?back|left[ _-]?arrow)\b/i;
// The journey's end and its failure states, by screen name: "Payment successful", "Payment failed".
var UXD_SUCCESS_SCREEN = /\b(success|successful|succeeded|done|complete|completed|thank|thanks|receipt|confirmed|confirmation)\b/i;
var UXD_ERROR_SCREEN = /\b(fail|failed|failure|error|declined|unsuccessful|rejected|timeout|timed out)\b/i;
var UXD_SCREEN_STOP = { screen: 1, page: 1, view: 1, the: 1, a: 1, an: 1, and: 1, of: 1, to: 1, my: 1, your: 1, v1: 1, v2: 1, v3: 1, new: 1, copy: 1 };
function uxdWords(text) {
  return String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w.length > 1 && !UXD_SCREEN_STOP[w] && !/^\d+$/.test(w); });
}
// A screen's role in a journey, by its name or its big title text ("Payment successful" as a heading).
function uxdScreenKind(screen) {
  var name = String(screen.name || "");
  if (UXD_ERROR_SCREEN.test(name)) return "error";
  if (UXD_SUCCESS_SCREEN.test(name)) return "end";
  var titles = uxdDescendants(screen, function (n) { return n.type === "TEXT" && n.visible !== false && typeof n.fontSize === "number" && n.fontSize >= 18; })
    .slice(0, 4).map(function (t) { return String(t.characters || ""); }).join(" ");
  if (UXD_ERROR_SCREEN.test(titles)) return "error";
  if (UXD_SUCCESS_SCREEN.test(titles) || /\b(paid|payment received|all set)\b/i.test(titles)) return "end";
  return "step";
}
async function localPrototypeWire(payload) {
  var screens = figma.currentPage.selection.filter(function (n) { return n.type === "FRAME" && n.parent && n.parent.type === "PAGE"; });
  if (screens.length < 2) throw new Error("Select 2 or more top-level screens to wire together.");
  screens = screens.slice(0, 12).sort(function (a, b) { return Math.abs(a.y - b.y) > a.height / 2 ? a.y - b.y : a.x - b.x; });
  var fix = payload && payload.fix === true;
  // Screens whose existing links are replaced (the screen a "next step" was built from).
  var replaceOn = payload && Array.isArray(payload.replaceOn) ? payload.replaceOn : [];
  var screenIds = screens.map(function (sc) { return sc.id; });
  var links = [];
  var flowStart = "";
  var hasSkip = screens.map(function (screen) {
    return uxdDescendants(screen, function (n) { return n.visible !== false && uxdLooksLikeButton(n) && UXD_SKIP_LABEL.test(String(uxdFirstText(n) || n.name).trim()); }).length > 0;
  });
  // A run (onboarding, carousel, wizard) is the screens that share a name once step numbers are
  // dropped ("Onboarding 1/2/3", "Step 2 of 4 · KYC"), plus any screen that has its own Skip.
  function runKey(screen) {
    return String(screen.name || "").toLowerCase().replace(/\b(step|slide|page|screen)\s*\d+(\s*(of|\/)\s*\d+)?\b/g, " ")
      .replace(/\b\d+\s*(of|\/)\s*\d+\b/g, " ").replace(/[\d#·•|–—_-]+/g, " ").replace(/\s+/g, " ").trim();
  }
  function afterSkip(index) {
    var key = runKey(screens[index]);
    for (var j = index + 1; j < screens.length; j++) if (!hasSkip[j] && (!key || runKey(screens[j]) !== key)) return screens[j];
    return index + 1 < screens.length ? screens[screens.length - 1] : null;
  }
  var sharedWords = {};
  uxdWords(screens[0].name).forEach(function (w) {
    if (screens.every(function (sc) { return uxdWords(sc.name).indexOf(w) >= 0; })) sharedWords[w] = true;
  });
  var kinds = screens.map(uxdScreenKind);
  var isError = kinds.map(function (k) { return k === "error"; });
  var isEnd = kinds.map(function (k) { return k === "end"; });
  // "Continue" goes to the next step of the happy path: never into a failure state.
  function nextStep(index) {
    for (var j = index + 1; j < screens.length; j++) if (!isError[j]) return screens[j];
    return null;
  }
  // A button keeps its own link, unless that link leads outside the selected flow (repointed) or
  // its screen is being re-wired on purpose.
  function keepsOwnLink(node, screen) {
    if (!node.reactions || !node.reactions.length) return false;
    if (replaceOn.indexOf(screen.id) >= 0) return false;
    var dests = [], navigates = false;
    node.reactions.forEach(function (r) {
      (Array.isArray(r.actions) ? r.actions : r.action ? [r.action] : []).forEach(function (a) {
        if (!a) return;
        // Hover/press variant swaps (CHANGE_TO) on a file's button component are not a link.
        if (a.type === "BACK" || a.type === "CLOSE" || a.type === "URL") navigates = true;
        if (a.type === "NODE" && a.destinationId && a.navigation !== "CHANGE_TO") { navigates = true; dests.push(a.destinationId); }
      });
    });
    if (!navigates) return false;
    return !dests.length || dests.some(function (d) { return screenIds.indexOf(d) >= 0; });
  }
  function byWords(words, screen) {
    var best = null, bestScore = 0;
    screens.forEach(function (other) {
      if (other === screen) return;
      // Words every selected screen shares (a journey title: "Pay EMI / 2 · Choose amount") name no one screen.
      var score = uxdWords(other.name).filter(function (w) { return words.indexOf(w) >= 0 && !sharedWords[w]; }).length;
      if (score > bestScore) { best = other; bestScore = score; }
    });
    return best;
  }
  screens.forEach(function (screen, index) {
    // Back arrow icons in the app bar (no label): BACK, on every step after the first.
    if (index > 0) uxdDescendants(screen, function (n) {
      return n.visible !== false && n.type !== "TEXT" && UXD_BACK_ICON.test(String(n.name || "")) && n.width <= 48 && n.height <= 48 &&
        !uxdDescendants(n, function (k) { return k.type === "TEXT" && String(k.characters || "").trim(); }).length;
    }).forEach(function (icon) {
      if (links.length >= 60 || keepsOwnLink(icon, screen) || typeof icon.setReactionsAsync !== "function") return;
      for (var p = icon.parent; p && p !== screen; p = p.parent) if (uxdLooksLikeButton(p) || UXD_BACK_ICON.test(String(p.name || "")) && p.width <= 48) return;
      links.push({ button: icon, label: icon.name, screen: screen.name, from: index, action: "BACK" });
    });
    uxdDescendants(screen, function (n) { return n.visible !== false && uxdLooksLikeButton(n); })
      .forEach(function (button) {
        if (links.length >= 60 || keepsOwnLink(button, screen) || typeof button.setReactionsAsync !== "function") return;
        for (var p = button.parent; p && p !== screen; p = p.parent) if (uxdLooksLikeButton(p)) return;
        if (links.some(function (l) { return l.button === button; })) return;
        var label = String(uxdFirstText(button) || button.name).trim();
        var base = { button: button, label: label, screen: screen.name, from: index };
        // "Back to loans", "Go back home": the named screen, else the journey's start.
        var named = /^(?:go\s+)?back\s+(?:to\s+)?(.+)$|^go\s+to\s+(.+)$|^(?:return|take me)\s+(?:to\s+)?(.+)$/i.exec(label);
        if (named) {
          var target = byWords(uxdWords(named[1] || named[2] || named[3]), screen);
          links.push(Object.assign(base, target ? { action: "NAVIGATE", destination: target } : { action: "NAVIGATE", toStart: true }));
          return;
        }
        if (UXD_BACK_LABEL.test(label) && !(isEnd[index] && /^close\b/i.test(label))) { links.push(Object.assign(base, { action: "BACK" })); return; }
        if (UXD_RETRY_LABEL.test(label)) { links.push(Object.assign(base, { action: "NAVIGATE", retry: true })); return; }
        // From the end (or a failure), Done / Home / Close returns to the journey's start.
        if ((isEnd[index] || isError[index]) && (UXD_HOME_LABEL.test(label) || UXD_NEXT_LABEL.test(label))) {
          var home = screens.filter(function (other) { return other !== screen && uxdWords(other.name).some(function (w) { return /^(home|dashboard)$/.test(w); }); })[0];
          links.push(Object.assign(base, home ? { action: "NAVIGATE", destination: home } : { action: "NAVIGATE", toStart: true }));
          return;
        }
        if (UXD_SKIP_LABEL.test(label)) {
          var end = afterSkip(index);
          if (end) links.push(Object.assign(base, { action: "NAVIGATE", destination: end }));
          return;
        }
        var best = byWords(uxdWords(label), screen);
        // A step's main or forward button never goes back: "Confirm payment" on step 3 shares a word with
        // "Payment method" (step 2) but moves on to step 4.
        var primaryLike = UXD_NEXT_LABEL.test(label) || /primary|cta|main/i.test(String(button.name || "")) && !/secondary|tertiary|ghost|text|link/i.test(String(button.name || ""));
        if (best && primaryLike && !isEnd[index] && !isError[index] && screens.indexOf(best) < index && !isEnd[screens.indexOf(best)]) best = nextStep(index);
        // A failure screen is reached only by its own name, never from the end of the journey.
        if (best && isError[screens.indexOf(best)] && isEnd[index]) best = null;
        if (!best && UXD_NEXT_LABEL.test(label) && !isEnd[index] && !isError[index]) best = nextStep(index);
        // The step's one main button with no matching label ("Pay ₹8,450") moves the journey on.
        if (!best && !isEnd[index] && !isError[index] && !links.some(function (l) { return l.from === index && l.action === "NAVIGATE"; }) &&
          /primary|cta|main|button|btn/i.test(String(button.name || "")) && !/secondary|tertiary|ghost|text|link/i.test(String(button.name || ""))) best = nextStep(index);
        if (best) links.push(Object.assign(base, { action: "NAVIGATE", destination: best }));
      });
    // A list screen with no button forward (its rows/cards are the way in): the first item opens the next step.
    if (!isEnd[index] && !isError[index] && !links.some(function (l) { return l.from === index && l.action === "NAVIGATE" && !l.toStart; }) && nextStep(index)) {
      var item = uxdDescendants(screen, function (n) {
        return n.visible !== false && (n.type === "INSTANCE" || n.type === "FRAME") && UXD_CARD_NAME.test(String(n.name || "")) && n.height >= 40 && !keepsOwnLink(n, screen);
      })[0];
      if (item && typeof item.setReactionsAsync === "function") links.push({ button: item, label: uxdFirstText(item) || item.name, screen: screen.name, from: index, action: "NAVIGATE", destination: nextStep(index) });
    }
  });
  // The journey's entry: the first happy-path screen nothing else leads to (not just the top-left one).
  var incoming = screens.map(function (sc) { return links.filter(function (l) { return l.destination === sc && !l.toStart; }).length; });
  var entryIndex = screens.findIndex(function (sc, i) { return !isEnd[i] && !isError[i] && incoming[i] === 0; });
  var entry = screens[entryIndex >= 0 ? entryIndex : 0];
  // Retry opens the step that failed: the happy-path step that leads to the end.
  var lastStep = null;
  links.forEach(function (l) { if (l.action === "NAVIGATE" && l.destination && isEnd[screens.indexOf(l.destination)]) lastStep = screens[l.from]; });
  if (!lastStep) for (var k = screens.length - 1; k >= 0; k--) if (!isEnd[k] && !isError[k]) { lastStep = screens[k]; break; }
  links.forEach(function (l) {
    if (l.toStart) { l.destination = entry; delete l.toStart; }
    if (l.retry) { if (lastStep && lastStep !== screens[l.from]) l.destination = lastStep; else l.action = "BACK"; delete l.retry; }
  });
  links = links.filter(function (l) { return l.action === "BACK" || (l.destination && l.destination !== screens[l.from]); });
  // No dead ends: every step but the last leads somewhere, every failure has a way out.
  var deadEnds = screens.filter(function (screen, i) {
    var out = links.some(function (l) { return l.from === i; });
    var wired = uxdDescendants(screen, function (n) { return n.reactions && n.reactions.length > 0; }).length > 0;
    return !out && !wired && (!isEnd[i] || isError[i]) && (i < screens.length - 1 || isError[i]);
  }).map(function (s) { return s.name; });
  var snapshot = [];
  if (fix && links.length) {
    if (typeof figma.commitUndo === "function") figma.commitUndo();
    for (var i = 0; i < links.length; i++) {
      var l = links[i];
      var action = l.action === "BACK" ? { type: "BACK" } : { type: "NODE", destinationId: l.destination.id, navigation: "NAVIGATE",
        transition: { type: "DISSOLVE", easing: { type: "EASE_OUT" }, duration: 0.3 }, preserveScrollPosition: false };
      var reactions = [{ trigger: { type: "ON_CLICK" }, actions: [action] }];
      // A layer inside a component instance may not keep the link Figma accepted (read back to check):
      // then the nearest instance around it, inside this screen, carries the link instead.
      var targets = [l.button];
      for (var up = l.button.parent; up && up.type !== "PAGE" && screenIds.indexOf(up.id) < 0; up = up.parent) if (up.type === "INSTANCE") targets.push(up);
      l.done = false;
      for (var t = 0; t < targets.length && !l.done; t++) {
        var node = targets[t];
        if (t > 0 && node.reactions && node.reactions.length) continue;
        var before = uxdCloneValue(node.reactions) || [];
        try {
          await node.setReactionsAsync(reactions);
          if (node.reactions && node.reactions.length) {
            snapshot.push({ id: node.id, prop: "reactions", before: before, after: uxdCloneValue(node.reactions) || [] });
            l.done = true;
            if (t > 0) l.on = node.name;
          }
        } catch (_) {}
      }
    }
    // The journey starts at its entry (a flow starting point). A start set on another selected screen moves.
    var page = figma.currentPage;
    try {
      var starts = Array.isArray(page.flowStartingPoints) ? page.flowStartingPoints : null;
      if (starts && !starts.some(function (f) { return f.nodeId === entry.id; })) {
        var beforeStarts = uxdCloneValue(starts) || [];
        var others = starts.filter(function (f) { return screenIds.indexOf(f.nodeId) < 0; });
        var moved = starts.filter(function (f) { return screenIds.indexOf(f.nodeId) >= 0; })[0];
        page.flowStartingPoints = others.concat([{ nodeId: entry.id, name: moved ? moved.name : String(entry.name || "Flow").slice(0, 60) }]);
        snapshot.push({ id: page.id, prop: "flowStartingPoints", before: beforeStarts, after: uxdCloneValue(page.flowStartingPoints) || [] });
        flowStart = entry.name;
      }
    } catch (_) {}
    if (typeof figma.commitUndo === "function") figma.commitUndo();
  }
  return { ok: true, screens: screens.map(function (s) { return s.name; }), entry: entry.name,
    links: links.map(function (l) { return { screen: l.screen, screenId: screens[l.from].id, label: String(l.label).slice(0, 40), action: l.action,
      to: l.destination ? l.destination.name : "", toId: l.destination ? l.destination.id : "", done: l.done === true, on: l.on || "" }; }),
    deadEnds: deadEnds, flowStart: flowStart, snapshot: snapshot };
}
// uxd-handoff:end
// uxd-learn:start
// Learn from corrections: when UX Direct creates a screen it stores a small baseline of style values on
// each layer it made. Later, "learn from my edits" diffs the designer's changes against that baseline and
// the UI turns repeated changes into lines in the file's design rules, so later tasks follow them.
var UXD_LEARN_MAX = 3000;
function uxdLearnRole(node) {
  if (node.type === "TEXT") return "text";
  if (uxdLooksLikeButton(node)) return "button";
  return "frame";
}
// A text's role, so one edit becomes a scoped rule ("Card title size: 20 px"), never one for all text.
function uxdLearnTextRole(node) {
  var parent = node.parent;
  if (parent && uxdLooksLikeButton(parent)) return "Button label";
  var inCard = false;
  for (var p = parent; p && p.type !== "PAGE"; p = p.parent) if (UXD_CARD_NAME.test(String(p.name || ""))) { inCard = true; break; }
  var name = String(node.name || "");
  var size = typeof node.fontSize === "number" ? node.fontSize : 14;
  var bold = node.fontName && /bold|semi|medium|heavy|black/i.test(String(node.fontName.style || ""));
  var role = /\b(title|heading|header|headline|h[1-3])\b/i.test(name) || size >= 22 || (bold && size >= 16) ? "title"
    : size <= 12 ? "caption" : "body text";
  if (role === "title" && !inCard && size >= 22) return "Screen title";
  return (inCard ? "Card " : "") + role;
}
function uxdLearnValues(node) {
  var v = { role: uxdLearnRole(node) };
  if (node.type === "TEXT") {
    if (typeof node.fontSize === "number") v.size = node.fontSize;
    v.textRole = uxdLearnTextRole(node);
    if (node.fontName && typeof node.fontName === "object" && typeof node.fontName.style === "string") v.weight = node.fontName.style;
    var th = uxdFillHex(node); if (th) v.color = th;
    return v;
  }
  if (["FRAME", "COMPONENT", "INSTANCE", "RECTANGLE"].indexOf(node.type) < 0) return null;
  if (typeof node.cornerRadius === "number") v.radius = node.cornerRadius;
  var fh = uxdFillHex(node); if (fh) v.fill = fh;
  if (node.layoutMode && node.layoutMode !== "NONE") {
    if (typeof node.itemSpacing === "number" && node.primaryAxisAlignItems !== "SPACE_BETWEEN") v.gap = node.itemSpacing;
    if (typeof node.paddingLeft === "number" && node.paddingLeft === node.paddingRight) v.padX = node.paddingLeft;
    if (typeof node.paddingTop === "number" && node.paddingTop === node.paddingBottom) v.padY = node.paddingTop;
  }
  if (v.role === "button" && typeof node.height === "number") v.height = Math.round(node.height);
  return Object.keys(v).length > 1 ? v : null;
}
function uxdLearnSubtree(root) {
  var out = [root];
  if (typeof root.findAll === "function") out = out.concat(root.findAll(function () { return true; }));
  return out.slice(0, UXD_LEARN_MAX);
}
async function localLearnBaseline(payload) {
  var ids = Array.isArray(payload.nodeIds) ? payload.nodeIds.slice(0, 20) : [];
  var stored = 0;
  for (var i = 0; i < ids.length; i++) {
    var root = await figma.getNodeByIdAsync(String(ids[i]));
    if (!root) continue;
    uxdLearnSubtree(root).forEach(function (n) {
      if (typeof n.getPluginData !== "function" || n.getPluginData("uxdCreated") !== "1") return;
      var values = uxdLearnValues(n);
      if (!values) return;
      n.setPluginData("uxdBaseline", JSON.stringify(values));
      stored++;
    });
  }
  return { ok: true, stored: stored };
}
function uxdLearnCandidates() {
  var roots = figma.currentPage.selection && figma.currentPage.selection.length ? figma.currentPage.selection : figma.currentPage.children || [];
  var seen = {}, out = [];
  roots.forEach(function (root) {
    uxdLearnSubtree(root).forEach(function (n) {
      if (out.length >= UXD_LEARN_MAX || seen[n.id] || typeof n.getPluginData !== "function") return;
      var raw = n.getPluginData("uxdBaseline");
      if (!raw) return;
      seen[n.id] = true;
      out.push({ node: n, raw: raw });
    });
  });
  return out;
}
async function localLearnCorrections(payload) {
  if (payload.restore && typeof payload.restore === "object") {
    var restored = 0;
    for (var id in payload.restore) {
      var node = await figma.getNodeByIdAsync(id);
      if (node && typeof node.setPluginData === "function") { node.setPluginData("uxdBaseline", String(payload.restore[id])); restored++; }
    }
    return { ok: true, restored: restored };
  }
  var groups = {}, previous = {}, scanned = 0, edited = 0;
  uxdLearnCandidates().forEach(function (entry) {
    var base = null;
    try { base = JSON.parse(entry.raw); } catch (_) { base = null; }
    if (!base) return;
    scanned++;
    var now = uxdLearnValues(entry.node);
    if (!now) return;
    var changed = false;
    Object.keys(base).forEach(function (prop) {
      if (prop === "role" || prop === "textRole" || now[prop] === undefined) return;
      var from = base[prop], to = now[prop];
      if (typeof from === "number" ? Math.abs(from - to) < 0.5 : from === to) return;
      changed = true;
      var key = base.role + "|" + (base.textRole || "") + "|" + prop + "|" + from + "|" + to;
      if (!groups[key]) groups[key] = { role: base.role, textRole: base.textRole || "", prop: prop, from: from, to: to, layers: 0, sample: entry.node.name };
      groups[key].layers++;
    });
    if (changed) {
      edited++;
      if (payload.commit) {
        previous[entry.node.id] = entry.raw;
        now.role = base.role;
        if (base.textRole) now.textRole = base.textRole;
        entry.node.setPluginData("uxdBaseline", JSON.stringify(now));
      }
    }
  });
  var changes = Object.keys(groups).map(function (k) { return groups[k]; })
    .sort(function (a, b) { return b.layers - a.layers; }).slice(0, 20);
  return { ok: true, scanned: scanned, edited: edited, changes: changes, previous: payload.commit ? previous : undefined };
}
// uxd-learn:end
// uxd-detached:start
// Detached-instance rescue, no model: frames that were detached from a component (Figma keeps
// detachedInfo on them) are found and, on "relink", replaced by a fresh instance of that component
// with the copy's texts carried over as overrides. Copies with texts the component has no slot for
// are reported, not touched. The copy is hidden, not deleted, so Revert is exact.
async function uxdDetachedComponent(node) {
  var info = node.detachedInfo;
  if (!info) return null;
  try {
    if (info.type === "local") {
      var c = await figma.getNodeByIdAsync(String(info.componentId || ""));
      return c && !c.removed && c.type === "COMPONENT" ? c : null;
    }
    if (info.type === "library" && typeof figma.importComponentByKeyAsync === "function") return await figma.importComponentByKeyAsync(String(info.componentKey || ""));
  } catch (_) {}
  return null;
}
function uxdTextSlots(root) {
  var slots = [], seen = {};
  uxdDescendants(root, function (n) { return n.type === "TEXT"; }).forEach(function (t) {
    var path = [];
    for (var p = t; p && p !== root; p = p.parent) path.unshift(String(p.name || ""));
    var key = path.join("/");
    seen[key] = (seen[key] || 0) + 1;
    slots.push({ key: key + "#" + seen[key], node: t });
  });
  return slots;
}
function uxdMapTexts(copy, instance) {
  var from = uxdTextSlots(copy).filter(function (s) { return s.node.visible !== false && String(s.node.characters || "").trim(); });
  var to = uxdTextSlots(instance);
  var byKey = {};
  to.forEach(function (s) { byKey[s.key] = s.node; });
  var pairs = [], missing = [];
  from.forEach(function (s, i) {
    var target = byKey[s.key] || (from.length === to.length ? to[i].node : null);
    if (target) pairs.push({ from: s.node, to: target }); else missing.push(String(s.node.characters).slice(0, 30));
  });
  return { pairs: pairs, missing: missing };
}
async function localDetachedRescue(payload) {
  var sel = figma.currentPage.selection;
  if (!sel.length) throw new Error("Select a screen or layers to check for detached components.");
  var fix = payload && payload.fix === true;
  var copies = [];
  sel.forEach(function (root) {
    [root].concat(uxdDescendants(root, function (n) { return n.type === "FRAME"; })).forEach(function (n) {
      if (n.type !== "FRAME" || !n.detachedInfo || n.visible === false || n.locked === true || uxdInsideInstance(n)) return;
      for (var p = n.parent; p; p = p.parent) if (copies.indexOf(p) >= 0) return;
      if (copies.length < 60) copies.push(n);
    });
  });
  var results = [], createdIds = [], restore = [];
  if (fix && copies.length && typeof figma.commitUndo === "function") figma.commitUndo();
  for (var i = 0; i < copies.length; i++) {
    var copy = copies[i];
    var entry = { id: copy.id, name: copy.name, component: "", status: "ready", reason: "" };
    results.push(entry);
    var component = await uxdDetachedComponent(copy);
    if (!component) { entry.status = "skipped"; entry.reason = copy.detachedInfo.type === "library" ? "its library component is not available in this file" : "its component was deleted"; continue; }
    entry.component = component.parent && component.parent.type === "COMPONENT_SET" ? component.parent.name + " / " + component.name : component.name;
    var instance = component.createInstance();
    var map = uxdMapTexts(copy, instance);
    if (map.missing.length) {
      instance.remove();
      entry.status = "skipped"; entry.reason = "the copy has text the component has no slot for: " + map.missing.slice(0, 3).join(", ");
      continue;
    }
    if (!fix) { instance.remove(); continue; }
    try {
      var parent = copy.parent;
      parent.insertChild(parent.children.indexOf(copy), instance);
      if (!parent.layoutMode || parent.layoutMode === "NONE" || copy.layoutPositioning === "ABSOLUTE") {
        if (copy.layoutPositioning === "ABSOLUTE") instance.layoutPositioning = "ABSOLUTE";
        instance.x = copy.x; instance.y = copy.y;
      } else {
        ["layoutAlign", "layoutGrow", "layoutSizingHorizontal", "layoutSizingVertical"].forEach(function (prop) {
          try { if (prop in copy) instance[prop] = copy[prop]; } catch (_) {}
        });
      }
      if ((Math.abs(instance.width - copy.width) > 1 || Math.abs(instance.height - copy.height) > 1) && typeof instance.resize === "function") {
        try { instance.resize(copy.width, copy.height); } catch (_) {}
      }
      for (var j = 0; j < map.pairs.length; j++) {
        var pair = map.pairs[j];
        if (pair.to.characters === pair.from.characters) continue;
        await uxdLoadTextFonts(pair.to);
        pair.to.characters = pair.from.characters;
      }
      instance.name = copy.name;
      if (typeof instance.setPluginData === "function") instance.setPluginData("uxdCreated", "1");
      copy.visible = false;
      createdIds.push(instance.id);
      restore.push({ id: copy.id, prop: "visible", before: true, after: false });
      entry.status = "relinked";
    } catch (error) {
      try { instance.remove(); } catch (_) {}
      entry.status = "skipped"; entry.reason = String(error && error.message || "could not place the instance").slice(0, 120);
    }
  }
  if (createdIds.length && typeof figma.commitUndo === "function") figma.commitUndo();
  return { ok: true, results: results, createdIds: createdIds, restore: restore };
}
// uxd-detached:end
// uxd-restore-missing:start
// Structural lint found 1-5 source texts missing from a generated screen. Instead of failing the
// run, clone the exact source TEXT layers into the matching parent of the UX Direct-created output
// (same parent name, else the output root at the same offset). Restored layers are tagged
// uxdCreated, so Revert removes them with the screen. No model is involved.
function uxdNormText(value) {
  return String(value || "").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, " ").trim().replace(/[.,:;!?…]+$/, "");
}
function uxdRestoreNeighbour(candidate, source, output) {
  // Source texts in reading order; walk outwards from the missing one until a text that occurs
  // exactly once in both trees is found (repeated texts like "Personal Loan" are ambiguous).
  var visibleText = function (n) { return n.type === "TEXT" && n.visible !== false; };
  var srcTexts = source.findAll(visibleText);
  var outTexts = output.findAll(function (n) { return visibleText(n) && !uxdInsideInstance(n); });
  var count = function (list, text) { var c = 0; for (var i = 0; i < list.length; i++) if (uxdNormText(list[i].characters) === text) c++; return c; };
  var at = srcTexts.indexOf(candidate);
  if (at < 0) return null;
  // Only neighbours inside the same source container (card) count.
  var box = candidate.parent;
  for (var hop = 0; hop < 3 && box && box !== source; hop++) {
    for (var d = 1; d < srcTexts.length; d++) {
      for (var side = 0; side < 2; side++) {
        var idx = side === 0 ? at - d : at + d;
        var n = srcTexts[idx];
        if (!n || n === candidate) continue;
        var inside = false;
        for (var p = n.parent; p; p = p.parent) if (p === box) { inside = true; break; }
        if (!inside) continue;
        var key = uxdNormText(n.characters);
        if (!key || count(srcTexts, key) !== 1 || count(outTexts, key) !== 1) continue;
        var match = outTexts.filter(function (o) { return uxdNormText(o.characters) === key; })[0];
        if (match && match.parent && typeof match.parent.insertChild === "function") return { node: match, after: side === 0 };
      }
    }
    box = box.parent;
  }
  return null;
}
async function localRestoreMissingTexts(payload) {
  var source = await figma.getNodeByIdAsync(String(payload.sourceRootId || ""));
  var output = await figma.getNodeByIdAsync(String(payload.outputRootId || ""));
  if (!source || !output || source.removed || output.removed) throw new Error("The source or generated frame was not found.");
  if (typeof output.getPluginData !== "function" || output.getPluginData("uxdCreated") !== "1") {
    throw new Error("\"" + output.name + "\" was not created by UX Direct, so missing texts are not added to it.");
  }
  if (typeof source.findAll !== "function" || typeof output.findAll !== "function") throw new Error("These layers cannot hold text.");
  var wanted = (Array.isArray(payload.texts) ? payload.texts : []).slice(0, 5);
  var sourceTexts = source.findAll(function (n) { return n.type === "TEXT" && n.visible !== false; });
  var used = [];
  var restored = [];
  var skipped = [];
  for (var i = 0; i < wanted.length; i++) {
    var raw = String(wanted[i] || "");
    var base = uxdNormText(raw.replace(/\s*\(copy \d+ of \d+\)$/, ""));
    if (!base) continue;
    var candidate = null;
    for (var j = 0; j < sourceTexts.length; j++) {
      var n = sourceTexts[j];
      if (used.indexOf(n) >= 0) continue;
      var text = uxdNormText(n.characters);
      if (text === base || (base.length >= 40 && text.indexOf(base) === 0)) { candidate = n; break; }
    }
    if (!candidate) { skipped.push(raw); continue; }
    used.push(candidate);
    var parentName = candidate.parent && candidate.parent !== source ? candidate.parent.name : "";
    var target = null;
    if (parentName) {
      target = output.findAll(function (n) {
        return n.name === parentName && typeof n.appendChild === "function" &&
          (n.type === "FRAME" || n.type === "COMPONENT" || n.type === "GROUP") && !uxdInsideInstance(n);
      })[0] || null;
    }
    // No same-named container: put the text beside its nearest source neighbour that the output still
    // shows, inside that neighbour's own container. A text never lands loose at the bottom of the
    // screen, outside the card it came from (benchmark escapedTexts).
    var screenLevel = candidate.parent === source;
    var neighbour = target || screenLevel ? null : uxdRestoreNeighbour(candidate, source, output);
    if (!target && !screenLevel && !neighbour) { skipped.push(raw); continue; }
    var clone = candidate.clone();
    if (target) {
      target.appendChild(clone);
      if (!target.layoutMode || target.layoutMode === "NONE") { clone.x = candidate.x; clone.y = candidate.y; }
    } else if (neighbour) {
      var host = neighbour.node.parent;
      host.insertChild(host.children.indexOf(neighbour.node) + (neighbour.after ? 1 : 0), clone);
      if (!host.layoutMode || host.layoutMode === "NONE") { clone.x = neighbour.node.x; clone.y = neighbour.node.y + (neighbour.after ? neighbour.node.height + 4 : -clone.height - 4); }
    } else {
      output.appendChild(clone);
      if (!output.layoutMode || output.layoutMode === "NONE") {
        clone.x = candidate.absoluteTransform[0][2] - source.absoluteTransform[0][2];
        clone.y = candidate.absoluteTransform[1][2] - source.absoluteTransform[1][2];
      }
    }
    clone.name = candidate.name;
    if (typeof clone.setPluginData === "function") clone.setPluginData("uxdCreated", "1");
    restored.push({ id: clone.id, text: raw, parent: target ? target.name : neighbour ? neighbour.node.parent.name : output.name });
  }
  if (restored.length && typeof figma.commitUndo === "function") figma.commitUndo();
  return { ok: true, restored: restored, skipped: skipped };
}
// uxd-restore-missing:end
async function runLocalTask(message) {
  var result = null;
  var errorText = null;
  try {
    if (typeof message.requestId !== "string" || UXD_LOCAL_TASK_OPS.indexOf(message.op) < 0) throw new Error("Unsupported local task operation.");
    assertUxDirectFileScope("local task " + message.op);
    var payload = message.payload && typeof message.payload === "object" ? message.payload : {};
    if (message.op === "read-tree") result = await localReadTree(payload);
    else if (message.op === "read-image") result = await localReadImage(payload);
    else if (message.op === "apply-image") result = await localApplyImage(payload);
    else if (message.op === "restore-fills") result = await localRestoreFills(payload);
    else if (message.op === "delete-created") result = await localDeleteCreated(payload);
    else if (message.op === "apply-direct-edits") result = await localApplyDirectEdits(payload);
    else if (message.op === "apply-hygiene-fixes") result = await localApplyHygieneFixes(payload);
    else if (message.op === "apply-theme") result = await localApplyTheme(payload);
    else if (message.op === "restore-theme-modes") result = await localRestoreThemeModes(payload);
    else if (message.op === "fill-realistic-data") result = await localFillRealisticData(payload);
    else if (message.op === "restore-texts") result = await localRestoreTexts(payload);
    else if (message.op === "restore-props") result = await localRestoreProps(payload);
    else if (message.op === "componentize-repeats") result = await localComponentizeRepeats(payload);
    else if (message.op === "find-icon-targets") result = await localFindIconTargets(payload);
    else if (message.op === "insert-icons") result = await localInsertIcons(payload);
    else if (message.op === "section-state") result = await localSectionState(payload);
    else if (message.op === "get-design-rules") result = await localGetDesignRules(payload);
    else if (message.op === "set-design-rules") result = await localSetDesignRules(payload);
    else if (message.op === "consistency") result = await localConsistency(payload);
    else if (message.op === "restore-missing-texts") result = await localRestoreMissingTexts(payload);
    else if (message.op === "detached-rescue") result = await localDetachedRescue(payload);
    else if (message.op === "handoff-notes") result = await localHandoffNotes(payload);
    else if (message.op === "prototype-wire") result = await localPrototypeWire(payload);
    else if (message.op === "learn-baseline") result = await localLearnBaseline(payload);
    else if (message.op === "learn-corrections") result = await localLearnCorrections(payload);
    else if (message.op === "commit-undo") { if (typeof figma.commitUndo === "function") figma.commitUndo(); result = { ok: true }; }
    else if (message.op === "trigger-undo") {
      if (typeof figma.triggerUndo !== "function") throw new Error("This Figma version cannot undo from a plugin. Use Cmd/Ctrl+Z.");
      figma.triggerUndo();
      result = { ok: true };
    }
  } catch (error) {
    errorText = error && error.message ? String(error.message).slice(0, 600) : "Local task failed.";
  }
  figma.ui.postMessage({ type: "uxd-local-result", requestId: message.requestId, result: result, error: errorText });
}

figma.ui.onmessage = async function (message) {
  if (!message) return;
  if (message.type === "native-api-probe-ack" && message.probeId && UXD_NATIVE_API_PROBE_WAITERS[message.probeId]) {
    var resolveProbe = UXD_NATIVE_API_PROBE_WAITERS[message.probeId];
    delete UXD_NATIVE_API_PROBE_WAITERS[message.probeId];
    resolveProbe();
    return;
  }
  if (message.type === "get-selection") { assertUxDirectFileScope("refresh selection"); sendSelection(); UXD_UI_READY = true; uxdDeliverQuickPrompt(); }
  if (message.type === "run-native-health-check") { assertUxDirectFileScope("start health-check command"); await runNativeApiHealthCheck(message.commandId); }
  if (message.type === "run-canvas-command") { assertUxDirectFileScope("start canvas command"); await runCanvasCommand(message.command); }
  if (message.type === "uxd-local-task") { await runLocalTask(message); }
  if (message.type === "close") { assertUxDirectFileScope("close plugin"); figma.closePlugin(); }
};
sendSelection();

}
// uxd-quick-actions:start
// Cmd+/ → "UX Direct" → type a task: Figma passes it as the "prompt" parameter. The plugin still
// opens its panel (network runs there) and the panel runs the task once the file is verified.
var UXD_QUICK_ACTION_SUGGESTIONS = ["fix hygiene", "add icons to these buttons", "fill with realistic data", "check hygiene",
  "ux audit", "add empty, loading and error states", "make 3 variations", "make this card cleaner", "show design rules", "revert",
  "check consistency", "find detached components", "add handoff notes", "wire the prototype", "learn from my edits"];
var UXD_PENDING_QUICK_PROMPT = "";
function uxdQuickActionSuggestions(query) {
  var q = String(query || "").trim().toLowerCase();
  var list = UXD_QUICK_ACTION_SUGGESTIONS.filter(function (item) { return !q || item.indexOf(q) >= 0; });
  // Figma already offers the typed text itself (freeform), so only the known tasks are listed.
  return list.slice(0, 10);
}
if (figma.parameters && typeof figma.parameters.on === "function") {
  figma.parameters.on("input", function (event) {
    // Suggestions only: no document access before the file allowlist check.
    if (event.key === "prompt") event.result.setSuggestions(uxdQuickActionSuggestions(event.query));
  });
}
var UXD_PENDING_QUICK_AUTORUN = true;
function uxdDeliverQuickPrompt() {
  if (!UXD_PENDING_QUICK_PROMPT) return;
  var prompt = UXD_PENDING_QUICK_PROMPT;
  UXD_PENDING_QUICK_PROMPT = "";
  figma.ui.postMessage({ type: "uxd-quick-action", prompt: prompt, autoRun: UXD_PENDING_QUICK_AUTORUN });
}
// Figma replays the last parameters on "Run last plugin" and some menu relaunches, which would rerun
// the previous task unasked. The same task as the last quick action is only prefilled, not run.
var UXD_LAST_QUICK_KEY = "uxdLastQuickPrompt";
async function uxdIsReplayedQuickPrompt(prompt) {
  try {
    if (!figma.clientStorage) return false;
    var last = await figma.clientStorage.getAsync(UXD_LAST_QUICK_KEY);
    await figma.clientStorage.setAsync(UXD_LAST_QUICK_KEY, prompt);
    return String(last || "").toLowerCase() === prompt.toLowerCase();
  } catch (_) { return false; }
}
figma.on("run", async function (event) {
  // Figma runs this file in "query mode" while the Cmd+/ parameter box is open, where showUI is not
  // allowed, so the panel starts here (after input), not at load. Plain launches fire "run" too.
  uxdBoot();
  var prompt = event && event.parameters && typeof event.parameters.prompt === "string" ? event.parameters.prompt.trim().slice(0, 500) : "";
  if (!prompt || !getUxDirectScopeDecision().allowed) return;
  UXD_PENDING_QUICK_AUTORUN = !(await uxdIsReplayedQuickPrompt(prompt));
  UXD_PENDING_QUICK_PROMPT = prompt;
  if (UXD_UI_READY) uxdDeliverQuickPrompt();
});
// uxd-quick-actions:end
var UXD_UI_READY = false;
var UXD_BOOTED = false;
function uxdBoot() {
  if (UXD_BOOTED) return;
  UXD_BOOTED = true;
  var uxdScopeDecision = getUxDirectScopeDecision();
  if (uxdScopeDecision.allowed) {
    startScopedPlugin();
  } else {
    figma.closePlugin("UX Direct blocked: " + uxdScopeDecision.reason + " Only the approved Zunaid_Workspace file is allowed.");
  }
}
// Without the parameters API (older hosts, test harnesses) there is no query mode: start right away.
if (!(figma.parameters && typeof figma.parameters.on === "function")) uxdBoot();

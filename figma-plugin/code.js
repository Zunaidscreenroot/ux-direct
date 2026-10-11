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
    availability("Plugin lifecycle", "figma.closePlugin", typeof figma.closePlugin === "function",
      "Available, not invoked because it would close the plugin.");
    availability("External navigation", "figma.openExternal", typeof figma.openExternal === "function",
      "Available, not invoked because it would open an external browser.");
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
      if (node.opacity !== 0.6 || node.fills.length !== 1) throw new Error("Rectangle style update did not persist.");
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

    // The previous native run stopped at this grouping operation. Inventory the API without invoking a potentially blocking document mutation.
    availability("Layout and styling", "figma.group", typeof figma.group === "function",
      "Availability only; grouping is not invoked by health checks to keep the persistent Test Lab run responsive.");
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
      var allVariables = await mutateLabAsync("read variables for reuse", function () { return figma.variables.getLocalVariablesAsync(); });
      var variable = allVariables.find(function (item) { return item.name === "probe/color" && item.variableCollectionId === collection.id; }) || null;
      if (!variable) variable = mutateLab("create persistent health variable", function () {
        return figma.variables.createVariable("probe/color", collection, "COLOR");
      });
      mutateLab("write persistent health variable", function () {
        variable.setValueForMode(collection.defaultModeId, { r: 0.2, g: 0.4, b: 0.6 });
      });
      var loaded = await mutateLabAsync("read persistent health variable", function () { return figma.variables.getVariableByIdAsync(variable.id); });
      if (!loaded || loaded.valuesByMode[collection.defaultModeId].r !== 0.2) throw new Error("Persistent variable value did not read back.");
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
    });

    add("Events", "Receive selection-change event from inactive page", "not-tested", "not-tested",
      "Skipped to preserve the user's active page; selectionchange events are tied to the current page.");

    await runTest("Events", "Register/remove listener with figma.off", async function () {
      var node = rect("UXD off API probe");
      var fired = false;
      var previousSelection = Array.from(testPage.selection);
      var listener = function () { fired = true; };
      mutateLab("register test selection listener", function () { figma.on("selectionchange", listener); });
      mutateLab("remove test selection listener", function () { figma.off("selectionchange", listener); });
      mutateLab("trigger selection after removal", function () { testPage.selection = [node]; });
      await new Promise(function (resolve) { setTimeout(resolve, 120); });
      mutateLab("restore selection after listener removal test", function () { testPage.selection = previousSelection; });
      if (fired) throw new Error("Removed listener still fired.");
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

    // These APIs exist, but executing them would disrupt the person using the plugin.
    availability("Plugin lifecycle", "figma.closePlugin", typeof figma.closePlugin === "function",
      "Available but not invoked because it would terminate the current session.");
    availability("External navigation", "figma.openExternal", typeof figma.openExternal === "function",
      "Available but not invoked because it would open an external browser.");
    availability("Notifications", "figma.notify", typeof figma.notify === "function",
      "Available but not invoked to avoid interrupting the user.");
    availability("Styles", "figma.getLocalPaintStylesAsync", typeof figma.getLocalPaintStylesAsync === "function",
      "Availability only; local paint styles are not fetched during this check.");
    availability("Styles", "figma.getLocalTextStylesAsync", typeof figma.getLocalTextStylesAsync === "function",
      "Availability only; local text styles are not fetched during this check.");
    availability("Styles", "figma.getLocalEffectStylesAsync", typeof figma.getLocalEffectStylesAsync === "function",
      "Availability only; local effect styles are not fetched during this check.");
    availability("Styles", "figma.getLocalGridStylesAsync", typeof figma.getLocalGridStylesAsync === "function",
      "Availability only; local grid styles are not fetched during this check.");
    availability("Components", "figma.getLocalComponentsAsync", typeof figma.getLocalComponentsAsync === "function",
      "Availability only; the complete local component library is not enumerated.");
    availability("Components", "figma.getLocalComponentSetsAsync", typeof figma.getLocalComponentSetsAsync === "function",
      "Availability only; the complete local component-set library is not enumerated.");
    availability("Styles", "figma.getStyleByIdAsync", typeof figma.getStyleByIdAsync === "function",
      "Availability only; no style is loaded by ID.");
    availability("Document loading", "figma.loadAllPagesAsync", typeof figma.loadAllPagesAsync === "function",
      "Availability only; full-document page loading is intentionally not invoked.");
    availability("Image API", "figma.createImage", typeof figma.createImage === "function",
      "Availability only; creating an image resource is not necessary for this self-test.");
    availability("Slice API", "figma.createSlice", typeof figma.createSlice === "function",
      "Availability only; no additional visible canvas nodes are created.");
    availability("Undo API", "figma.triggerUndo", typeof figma.triggerUndo === "function",
      "Availability only; undo is never triggered because it could alter the user's edit history.");
    availability("Plugin UI", "figma.ui.resize", typeof figma.ui.resize === "function",
      "Availability only; the running plugin panel is not resized.");
    availability("Plugin UI", "figma.ui.on", typeof figma.ui.on === "function",
      "Availability only; the existing message wiring is left unchanged.");
    availability("Plugin UI", "figma.ui.off", typeof figma.ui.off === "function",
      "Availability only; no user message handlers are removed.");
    availability("Variables", "figma.variables.getVariableCollectionByIdAsync",
      !!figma.variables && typeof figma.variables.getVariableCollectionByIdAsync === "function",
      "Availability only; collections are not looked up by an arbitrary ID.");
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

// STRICT SCOPE: reject every file except the exact allowlisted key before reading document pages.
// STRICT SCOPE: plugin entry runs only after the exact approved Figma file key matches.
var UXD_ALLOWED_FILE_NAME = "Zunaid_Workspace";
var UXD_ALLOWED_FILE_KEY = "QJhcsebwscpdMJDNh9UsYS";
var UXD_API_TEST_LAB_PAGE = "UXD API Test Lab";
var UXD_NATIVE_API_PROBE_WAITERS = Object.create(null);
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
async function runNativeApiHealthCheck(commandId) {
  var checks = [];
  var createdNodes = [];
  var temporaryPages = [];
  var temporaryCollections = [];
  var testPage = null;
  var harness = null;
  var originalPage = null;
  var savedTestSelection = null;
  var storageKey = null;
  var selectionHandlerPaused = false;
  var cleanupErrors = [];

  function add(category, name, level, status, reason) {
    checks.push({ category: category, name: name, level: level, status: status,
      reason: reason || (status === "success" ? "Executed and verified" : "Operation failed") });
  }
  function assertLab(name) {
    assertUxDirectFileScope(name);
    if (!testPage || !figma.currentPage || figma.currentPage.id !== testPage.id) {
      throw new Error("Blocked " + name + ": the active page is not UXD API Test Lab.");
    }
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
    try {
      assertUxDirectFileScope(name);
      if (needsLab !== false) assertLab(name);
      await fn();
      assertUxDirectFileScope(name + " verification");
      if (needsLab !== false) assertLab(name + " verification");
      add(category, name, "functional", "success", "Actual API operation executed and verified inside the allowlisted file.");
      return true;
    } catch (error) {
      add(category, name, "functional", "error", error && error.message ? error.message : String(error));
      return false;
    }
  }
  function createNode(factory, name, parent) {
    var node = mutateLab("create " + name, factory);
    createdNodes.push(node);
    if (name) mutateLab("name " + name, function () { node.name = name; });
    if (parent && node.parent !== parent) mutateLab("attach " + name, function () { parent.appendChild(node); });
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
  async function postResult() {
    try { assertUxDirectFileScope("report health-check results"); } catch (_) { return; }
    var passed = checks.filter(function (x) { return x.status === "success" && x.level !== "availability"; }).length;
    var available = checks.filter(function (x) { return x.status === "success" && x.level === "availability"; }).length;
    var failed = checks.filter(function (x) { return x.status === "error"; }).length;
    var notTested = checks.filter(function (x) { return x.status === "not-tested"; }).length;
    figma.ui.postMessage({ type: "native-health-result", checks: checks, passed: passed,
      available: available, failed: failed, notTested: notTested,
      commandId: commandId || null, checkedAt: new Date().toISOString() });
  }

  try {
    assertUxDirectFileScope("starting native API health check");
    originalPage = figma.currentPage;
  } catch (error) {
    add("Security", "Revalidate exact Figma file key", "functional", "error", error && error.message ? error.message : String(error));
    await postResult();
    return;
  }

  var labReady = await runTest("Test isolation", "Create/find UXD API Test Lab page", async function () {
    var pages = mutateFile("locate test lab in current file", function () { return figma.root.children; });
    testPage = pages.find(function (page) { return page.name === UXD_API_TEST_LAB_PAGE; }) || null;
    if (!testPage) {
      testPage = mutateFile("create isolated test page", function () { return figma.createPage(); });
      mutateFile("name isolated test page", function () { testPage.name = UXD_API_TEST_LAB_PAGE; });
    }
    await mutateFileAsync("load isolated test page", function () { return testPage.loadAsync(); });
    await mutateFileAsync("navigate to isolated test page", function () { return figma.setCurrentPageAsync(testPage); });
    if (figma.currentPage.id !== testPage.id) throw new Error("Figma did not activate UXD API Test Lab.");
  }, false);

  if (!labReady || !testPage) {
    availability("Plugin lifecycle", "figma.closePlugin", typeof figma.closePlugin === "function",
      "Available, not invoked because it would close the plugin.");
    availability("External navigation", "figma.openExternal", typeof figma.openExternal === "function",
      "Available, not invoked because it would open an external browser.");
    add("Library", "Team Library access", "not-tested", "not-tested",
      "Intentionally outside scope: no teamlibrary permission, shared-library lookup, or import is enabled.");
    await postResult();
    return;
  }

  // Avoid sending temporary test-page selections to backend telemetry during the suite.
  try {
    assertLab("pause selection context listener");
    figma.off("selectionchange", sendSelection);
    selectionHandlerPaused = true;
  } catch (error) {
    add("Events", "Pause selection context messaging", "functional", "error", error && error.message ? error.message : String(error));
  }

  try {
    await runTest("Test isolation", "Create temporary smoke-test container frame", async function () {
      harness = createNode(function () { return figma.createFrame(); }, "__UXD API TEST RUN " + Date.now(), null);
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
    await runTest("Node inspection", "Resolve a node by legacy synchronous ID lookup", async function () {
      if (typeof figma.getNodeById !== "function") throw new Error("Legacy getNodeById is unavailable.");
      var found = mutateLab("resolve test node using getNodeById", function () { return figma.getNodeById(harness.id); });
      if (!found || found.id !== harness.id) throw new Error("getNodeById failed to resolve the test frame.");
    });
    await runTest("Viewport", "Read viewport zoom and bounds", async function () {
      var bounds = mutateLab("read viewport bounds", function () { return figma.viewport.bounds; });
      var zoom = mutateLab("read viewport zoom", function () { return figma.viewport.zoom; });
      if (!bounds || typeof zoom !== "number" || zoom <= 0) throw new Error("Viewport bounds or zoom were invalid.");
    });

    await runTest("Page navigation", "Create and remove a temporary page", async function () {
      var page = mutateFile("create temporary navigation page", function () { return figma.createPage(); });
      temporaryPages.push(page);
      mutateFile("name temporary navigation page", function () { page.name = "__UXD TEMP PAGE " + Date.now(); });
      if (!figma.root.children.some(function (candidate) { return candidate.id === page.id; })) {
        throw new Error("New page was not found in the current document.");
      }
      mutateFile("remove temporary navigation page", function () { page.remove(); });
      temporaryPages = temporaryPages.filter(function (candidate) { return candidate.id !== page.id; });
      if (figma.root.children.some(function (candidate) { return candidate.id === page.id; })) {
        throw new Error("Temporary page still exists after removal.");
      }
    });

    await runTest("Page navigation", "Switch to a temporary page and back", async function () {
      var page = mutateFile("create switch-test page", function () { return figma.createPage(); });
      temporaryPages.push(page);
      mutateFile("name switch-test page", function () { page.name = "__UXD NAV TEST " + Date.now(); });
      await mutateFileAsync("load switch-test page", function () { return page.loadAsync(); });
      await mutateFileAsync("switch to temporary page", function () { return figma.setCurrentPageAsync(page); });
      if (figma.currentPage.id !== page.id) throw new Error("setCurrentPageAsync did not activate the temporary page.");
      await mutateFileAsync("return to API test lab", function () { return figma.setCurrentPageAsync(testPage); });
      if (figma.currentPage.id !== testPage.id) throw new Error("setCurrentPageAsync did not return to API test lab.");
      mutateFile("remove switch-test page", function () { page.remove(); });
      temporaryPages = temporaryPages.filter(function (candidate) { return candidate.id !== page.id; });
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
    await runTest("Shapes", "Remove a temporary node", async function () {
      var node = rect("UXD API removable rectangle");
      var id = node.id;
      mutateLab("remove temporary rectangle", function () { node.remove(); });
      if (await figma.getNodeByIdAsync(id)) throw new Error("Temporary rectangle still exists after remove().");
    });

    await runTest("Text", "Create text, load font, write characters", async function () {
      var node = createNode(function () { return figma.createText(); }, "UXD API test text", harness);
      var fontName = node.fontName;
      if (!fontName || fontName === figma.mixed) throw new Error("Text node did not expose a single font.");
      await mutateLabAsync("load font for test text", function () { return figma.loadFontAsync(fontName); });
      mutateLab("write test characters", function () { node.characters = "UX Direct API test"; });
      if (node.characters !== "UX Direct API test") throw new Error("Text write did not persist.");
    });

    await runTest("Layout and styling", "Group two test nodes", async function () {
      var a = rect("UXD group item A"), b = ellipse("UXD group item B");
      mutateLab("position group item A", function () { a.x = 5; a.y = 5; });
      mutateLab("position group item B", function () { b.x = 35; b.y = 25; });
      var group = mutateLab("group test nodes", function () { return figma.group([a, b], harness); });
      createdNodes.push(group);
      if (group.type !== "GROUP" || group.children.length !== 2) throw new Error("Group did not contain both nodes.");
    });
    await runTest("Layout and styling", "Flatten test nodes", async function () {
      var a = rect("UXD flatten item A"), b = ellipse("UXD flatten item B");
      mutateLab("position flatten item", function () { b.x = 25; b.y = 25; });
      var vector = mutateLab("flatten test nodes", function () { return figma.flatten([a, b], harness); });
      createdNodes.push(vector);
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
      await runTest("Layout and styling", "Execute " + operation.name + " boolean operation", async function () {
        var a = rect("UXD boolean A"), b = ellipse("UXD boolean B");
        mutateLab("position boolean-test node", function () { b.x = 25; });
        var result = mutateLab("execute boolean operation", function () { return operation.fn([a, b], harness); });
        createdNodes.push(result);
        if (result.type !== "BOOLEAN_OPERATION") throw new Error(operation.name + " did not return a BOOLEAN_OPERATION.");
      });
    }

    await runTest("Components", "Create component and instance", async function () {
      var component = createNode(function () { return figma.createComponent(); }, "UXD API test component", harness);
      mutateLab("resize test component", function () { component.resize(100, 60); });
      rect("UXD component child", component);
      var instance = mutateLab("create test component instance", function () { return component.createInstance(); });
      createdNodes.push(instance);
      var main = await mutateLabAsync("resolve instance main component", function () { return instance.getMainComponentAsync(); });
      if (!main || main.id !== component.id) throw new Error("Instance did not resolve to its main component.");
    });
    await runTest("Components", "Create component from frame", async function () {
      var frame = createNode(function () { return figma.createFrame(); }, "UXD frame to component", harness);
      rect("UXD component source child", frame);
      var component = mutateLab("convert frame to component", function () { return figma.createComponentFromNode(frame); });
      createdNodes.push(component);
      if (component.type !== "COMPONENT") throw new Error("createComponentFromNode did not produce a component.");
    });
    await runTest("Components", "Combine components as variants", async function () {
      var a = createNode(function () { return figma.createComponent(); }, "UXD variant A", harness);
      var b = createNode(function () { return figma.createComponent(); }, "UXD variant B", harness);
      mutateLab("resize variant A", function () { a.resize(100, 60); });
      mutateLab("resize variant B", function () { b.resize(100, 60); });
      var set = mutateLab("combine variants", function () { return figma.combineAsVariants([a, b], harness); });
      createdNodes.push(set);
      if (set.type !== "COMPONENT_SET" || set.children.length !== 2) throw new Error("Component set did not contain both variants.");
    });

    await runTest("Variables", "Create/write/read/remove temporary variable collection", async function () {
      if (!figma.variables || typeof figma.variables.createVariableCollection !== "function" || typeof figma.variables.createVariable !== "function") {
        throw new Error("Variable write APIs are unavailable.");
      }
      var collection = mutateLab("create temporary variable collection", function () {
        return figma.variables.createVariableCollection("__UXD TEMP HEALTH " + Date.now());
      });
      temporaryCollections.push(collection);
      var variable = mutateLab("create temporary variable", function () {
        return figma.variables.createVariable("probe/color", collection, "COLOR");
      });
      mutateLab("write temporary variable", function () {
        variable.setValueForMode(collection.defaultModeId, { r: 0.2, g: 0.4, b: 0.6 });
      });
      var loaded = await mutateLabAsync("read temporary variable", function () { return figma.variables.getVariableByIdAsync(variable.id); });
      if (!loaded || loaded.valuesByMode[collection.defaultModeId].r !== 0.2) throw new Error("Temporary variable value did not read back.");
      mutateLab("remove temporary variable collection", function () { collection.remove(); });
      temporaryCollections = temporaryCollections.filter(function (item) { return item.id !== collection.id; });
      if (await figma.variables.getVariableByIdAsync(variable.id)) throw new Error("Temporary variable still exists after collection removal.");
    });
    await runTest("Variables", "Read local variables and collections", async function () {
      var variables = await mutateLabAsync("read local variable list", function () { return figma.variables.getLocalVariablesAsync(); });
      var collections = await mutateLabAsync("read local variable collection list", function () { return figma.variables.getLocalVariableCollectionsAsync(); });
      if (!Array.isArray(variables) || !Array.isArray(collections)) throw new Error("Local variable APIs returned invalid results.");
    });

    await runTest("Storage", "Write/read/delete temporary client-storage key", async function () {
      storageKey = "uxd.health.probe." + Date.now();
      await mutateLabAsync("write client-storage test key", function () { return figma.clientStorage.setAsync(storageKey, "uxd-test-value"); });
      var value = await mutateLabAsync("read client-storage test key", function () { return figma.clientStorage.getAsync(storageKey); });
      if (value !== "uxd-test-value") throw new Error("clientStorage returned a different value.");
      await mutateLabAsync("delete client-storage test key", function () { return figma.clientStorage.deleteAsync(storageKey); });
      storageKey = null;
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

    await runTest("Events", "Receive a selection-change event", async function () {
      var node = rect("UXD selection event probe");
      savedTestSelection = Array.from(testPage.selection);
      var delivered = false;
      var eventPromise = new Promise(function (resolve) {
        figma.once("selectionchange", function () { delivered = true; resolve(true); });
      });
      mutateLab("select event test node", function () { testPage.selection = [node]; });
      var received = await Promise.race([
        eventPromise,
        new Promise(function (resolve) { setTimeout(function () { resolve(false); }, 1800); })
      ]);
      mutateLab("restore page selection after event", function () { testPage.selection = savedTestSelection; });
      savedTestSelection = null;
      if (!received || !delivered) throw new Error("selectionchange event did not arrive within 1.8 seconds.");
    });
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
    add("Library", "Team Library access", "not-tested", "not-tested",
      "Intentionally outside scope. No teamlibrary permission or shared-library import/query is enabled.");
  } catch (error) {
    add("Test runner", "Unexpected health-check failure", "functional", "error", error && error.message ? error.message : String(error));
  } finally {
    try { assertUxDirectFileScope("health-test cleanup"); } catch (_) {}
    if (testPage) {
      try {
        if (figma.currentPage.id !== testPage.id) await mutateFileAsync("return to lab for cleanup", function () { return figma.setCurrentPageAsync(testPage); });
      } catch (error) { cleanupErrors.push("Could not return to API Test Lab: " + (error.message || String(error))); }
      if (savedTestSelection) {
        try { mutateLab("restore test-page selection during cleanup", function () { testPage.selection = savedTestSelection; }); }
        catch (error) { cleanupErrors.push("Could not restore test-page selection: " + (error.message || String(error))); }
      }
      function belongsToHarness(node) {
        var current = node;
        while (current) {
          if (harness && current.id === harness.id) return true;
          current = current.parent;
        }
        return false;
      }
      // Removing the lab's single temporary harness removes all descendants in one scoped operation.
      // If any API failed before attaching a node to the harness, clean that orphan separately.
      for (var i = createdNodes.length - 1; i >= 0; i--) {
        var node = createdNodes[i];
        try {
          if (node && node.parent && !belongsToHarness(node)) {
            assertLab("remove orphaned temporary test node");
            node.remove();
          }
        } catch (error) {
          cleanupErrors.push("Could not remove orphaned " + (node && node.name ? node.name : "test node") + ": " + (error.message || String(error)));
        }
      }
      if (harness) {
        try {
          if (harness.parent) mutateLab("remove all temporary harness contents", function () { harness.remove(); });
        } catch (error) {
          cleanupErrors.push("Could not remove temporary test harness and its children: " + (error.message || String(error)));
        }
      }
      for (var c = temporaryCollections.length - 1; c >= 0; c--) {
        try { assertUxDirectFileScope("remove temporary variable collection"); temporaryCollections[c].remove(); }
        catch (error) { cleanupErrors.push("Could not remove temporary variable collection: " + (error.message || String(error))); }
      }
      if (storageKey) {
        try { assertUxDirectFileScope("delete temporary client-storage key"); await figma.clientStorage.deleteAsync(storageKey); }
        catch (error) { cleanupErrors.push("Could not clear temporary client storage: " + (error.message || String(error))); }
      }
    }
    for (var p = temporaryPages.length - 1; p >= 0; p--) {
      try {
        assertUxDirectFileScope("remove temporary page");
        if (figma.root.children.some(function (page) { return page.id === temporaryPages[p].id; }) &&
            temporaryPages[p].id !== (testPage && testPage.id) &&
            temporaryPages[p].id !== (originalPage && originalPage.id)) temporaryPages[p].remove();
      } catch (error) { cleanupErrors.push("Could not remove temporary page: " + (error.message || String(error))); }
    }
    if (originalPage) {
      try { await mutateFileAsync("restore originally active page", function () { return figma.setCurrentPageAsync(originalPage); }); }
      catch (error) { cleanupErrors.push("Could not restore original page: " + (error.message || String(error))); }
    }
    if (selectionHandlerPaused) {
      try { assertUxDirectFileScope("restore selection context listener"); figma.on("selectionchange", sendSelection); }
      catch (error) { cleanupErrors.push("Could not restore selection listener: " + (error.message || String(error))); }
    }
    if (originalPage) { try { sendSelection(); } catch (_) {} }
    cleanupErrors.forEach(function (reason, index) {
      add("Test cleanup", "Cleanup issue " + (index + 1), "functional", "error", reason);
    });
  }
  await postResult();
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

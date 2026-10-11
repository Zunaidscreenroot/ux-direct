figma.showUI(__html__, { width: 380, height: 640, themeColors: true });

function getSelectionSummary() {
  return figma.currentPage.selection.map(function (node) {
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      visible: node.visible,
      childCount: "children" in node ? node.children.length : undefined
    };
  });
}

function sendSelection() {
  figma.ui.postMessage({
    type: "selection",
    fileKey: figma.fileKey || null,
    pageName: figma.currentPage.name,
    selection: getSelectionSummary()
  });
}

figma.on("selectionchange", sendSelection);
function runNativeApiHealthCheck() {
  var checks = [];
  function check(name, ok, reason) { checks.push({ name: name, status: ok ? "success" : "error", reason: ok ? "Available" : reason }); }
  function has(path, value) { check(path, value !== undefined && value !== null, "API/property unavailable in this plugin runtime"); }
  has("figma.currentPage", figma.currentPage);
  has("figma.currentPage.selection", figma.currentPage && figma.currentPage.selection);
  has("figma.root", figma.root);
  has("figma.viewport", figma.viewport);
  has("figma.ui", figma.ui);
  has("figma.on", figma.on);
  has("figma.off", figma.off);
  has("figma.getNodeByIdAsync", figma.getNodeByIdAsync);
  has("figma.getNodeById", figma.getNodeById);
  has("figma.createFrame", figma.createFrame);
  has("figma.createComponent", figma.createComponent);
  has("figma.createText", figma.createText);
  has("figma.createRectangle", figma.createRectangle);
  has("figma.createEllipse", figma.createEllipse);
  has("figma.createPage", figma.createPage);
  has("figma.loadFontAsync", figma.loadFontAsync);
  has("figma.notify", figma.notify);
  has("figma.clientStorage", figma.clientStorage);
  has("figma.variables", figma.variables);
  has("figma.teamLibrary", figma.teamLibrary);
  has("figma.currentPage.findAll", figma.currentPage && figma.currentPage.findAll);
  has("figma.currentPage.appendChild", figma.currentPage && figma.currentPage.appendChild);
  var selection = figma.currentPage && figma.currentPage.selection;
  check("Selection readable", Array.isArray(selection), "Current selection could not be read");
  check("Page name readable", Boolean(figma.currentPage && typeof figma.currentPage.name === "string"), "Current page name unavailable");
  check("Plugin UI message bridge", Boolean(figma.ui && typeof figma.ui.postMessage === "function"), "Plugin UI message bridge unavailable");
  check("Selection metadata extraction", Array.isArray(getSelectionSummary()), "Selection metadata extraction failed");
  check("Plugin file context readable", typeof figma.fileKey === "string" || figma.fileKey === null, "File context could not be read");
  check("Viewport bounds readable", Boolean(figma.viewport && figma.viewport.bounds), "Viewport bounds unavailable");
  check("Viewport zoom readable", Boolean(figma.viewport && typeof figma.viewport.zoom === "number"), "Viewport zoom unavailable");
  check("Current page id readable", Boolean(figma.currentPage && figma.currentPage.id), "Current page id unavailable");
  check("Current page children readable", Boolean(figma.currentPage && Array.isArray(figma.currentPage.children)), "Page children unavailable");
  figma.ui.postMessage({ type: "native-health-result", checks: checks, passed: checks.filter(function (item) { return item.status === "success"; }).length, failed: checks.filter(function (item) { return item.status === "error"; }).length, checkedAt: new Date().toISOString() });
}
figma.ui.onmessage = function (message) {
  if (message.type === "get-selection") sendSelection();
  if (message.type === "run-native-health-check") runNativeApiHealthCheck();
  if (message.type === "close") figma.closePlugin();
};
sendSelection();

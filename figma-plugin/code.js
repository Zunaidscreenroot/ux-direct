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
figma.ui.onmessage = function (message) {
  if (message.type === "get-selection") sendSelection();
  if (message.type === "close") figma.closePlugin();
};
sendSelection();

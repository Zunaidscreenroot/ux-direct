figma.showUI(__html__, { width: 380, height: 640, themeColors: true });

type SelectedNodeSummary = {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  childCount?: number;
};

function getSelectionSummary(): SelectedNodeSummary[] {
  return figma.currentPage.selection.map((node) => ({
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    childCount: "children" in node ? node.children.length : undefined,
  }));
}

function sendSelection() {
  figma.ui.postMessage({
    type: "selection",
    fileKey: figma.fileKey ?? null,
    pageName: figma.currentPage.name,
    selection: getSelectionSummary(),
  });
}

figma.on("selectionchange", sendSelection);
figma.ui.onmessage = async (message: { type?: string }) => {
  if (message.type === "get-selection") sendSelection();
  if (message.type === "close") figma.closePlugin();
};

sendSelection();

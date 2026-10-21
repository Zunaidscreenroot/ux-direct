export type DesignPlanQualityFinding = {
  code: "missing-source-content" | "fixed-layout-overflow" | "child-out-of-bounds" | "low-contrast" | "implicit-frame-fill";
  severity: "high" | "medium";
  message: string;
};

export type DesignPlanQualityReport = {
  passed: boolean;
  score: number;
  findings: DesignPlanQualityFinding[];
};

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nodesOf(value: unknown): RecordLike[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function childrenOf(node: RecordLike): RecordLike[] {
  return nodesOf(node.children);
}

function fold(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^a-z0-9₹]/g, "");
}

function collectText(nodes: RecordLike[], output: string[] = [], depth = 0): string[] {
  if (depth > 8) return output;
  for (const node of nodes) {
    if (node.type === "TEXT" && typeof node.text === "string" && node.text.trim()) {
      output.push(node.text.trim().slice(0, 240));
    }
    collectText(childrenOf(node), output, depth + 1);
  }
  return output;
}

function hasExplicitRemoval(text: string, prompt: string): boolean {
  const normalizedText = fold(text);
  if (!normalizedText) return false;
  const escaped = text.trim().split("").map((character) =>
    "\\.^$|?*+()[]{}".includes(character) ? "\\" + character : character
  ).join("");
  const mentionedAfterRemovalVerb = new RegExp(
    "\\b(remove|delete|hide|omit|exclude|replace|rewrite|rename)\\b[^.!?]{0,80}\\b" + escaped + "\\b",
    "i",
  ).test(prompt);
  const mentionedBeforeRemovalVerb = new RegExp(
    "\\b" + escaped + "\\b[^.!?]{0,80}\\b(remove|delete|hide|omit|exclude|replace|rewrite|rename)\\b",
    "i",
  ).test(prompt);
  const explicitCopyChange = new RegExp(
    "\\b(change|update|rewrite|rename|replace)\\b[^.!?]{0,80}\\b" + escaped +
      "\\b[^.!?]{0,60}\\b(to|as|with)\\b",
    "i",
  ).test(prompt);
  return mentionedAfterRemovalVerb || mentionedBeforeRemovalVerb || explicitCopyChange;
}

function hexToRgb(value: unknown): [number, number, number] | null {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) return null;
  return [
    Number.parseInt(value.slice(1, 3), 16) / 255,
    Number.parseInt(value.slice(3, 5), 16) / 255,
    Number.parseInt(value.slice(5, 7), 16) / 255,
  ];
}

function luminance(rgb: [number, number, number]): number {
  const linear = rgb.map((component) =>
    component <= 0.04045 ? component / 12.92 : Math.pow((component + 0.055) / 1.055, 2.4)
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground: string, background: string): number | null {
  const fg = hexToRgb(foreground);
  const bg = hexToRgb(background);
  if (!fg || !bg) return null;
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function dimension(node: RecordLike, key: "width" | "height"): number {
  return typeof node[key] === "number" && Number.isFinite(node[key]) ? Number(node[key]) : 0;
}

function padding(node: RecordLike, key: "paddingLeft" | "paddingRight" | "paddingTop" | "paddingBottom"): number {
  return typeof node[key] === "number" && Number.isFinite(node[key]) ? Number(node[key]) : 0;
}

/**
 * Deterministic preflight for native Figma design plans. This runs before any
 * canvas writes, so missing source data, clipped Auto Layout content, and
 * unreadable text cause a regeneration attempt rather than a misleading success.
 */
export function auditDesignPlanQuality(
  planValue: unknown,
  sourceCanvasValue: unknown,
  promptValue = "",
): DesignPlanQualityReport {
  const plan = isRecord(planValue) ? planValue : {};
  const planFrame = isRecord(plan.frame) ? plan.frame : {};
  const prompt = typeof promptValue === "string" ? promptValue : "";
  const sourceCanvas = isRecord(sourceCanvasValue) ? sourceCanvasValue : {};
  const sourceNodes = nodesOf(sourceCanvas.nodes);
  const outputNodes = nodesOf(plan.elements);
  const findings: DesignPlanQualityFinding[] = [];
  const seen = new Set<string>();

  const add = (code: DesignPlanQualityFinding["code"], severity: DesignPlanQualityFinding["severity"], message: string) => {
    const key = code + ":" + message;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ code, severity, message: message.slice(0, 420) });
  };

  const sourceTexts = collectText(sourceNodes);
  const outputTexts = collectText(outputNodes);
  const outputCorpus = fold(outputTexts.join(" "));
  const sourceUnique = [...new Set(sourceTexts)];
  // Retain all source copy/data by default. A removal/rewrite is allowed only
  // when the request names the exact source text it intends to change.
  const missing = sourceUnique.filter((text) => {
    const normalized = fold(text);
    if (!normalized || normalized.length < 2 || hasExplicitRemoval(text, prompt)) return false;
    return !outputCorpus.includes(normalized);
  });

  // Values and identifiers are especially easy for a generative model to drop.
  // Validate them independently so text simplification cannot hide financial-data loss.
  const criticalSourceValues = [...new Set(sourceTexts.flatMap((text) => {
    const values = text.match(/(?:₹|INR)\s*[\d,]+(?:\.\d{1,2})?/gi) || [];
    const identifiers = text.match(/\b[A-Z]{2,}[A-Z0-9-]{6,}\b/g) || [];
    return [...values, ...identifiers];
  }))];
  const missingCriticalValues = criticalSourceValues.filter((value) => {
    if (hasExplicitRemoval(value, prompt)) return false;
    return !outputCorpus.includes(fold(value));
  });
  if (missing.length) {
    add(
      "missing-source-content",
      "high",
      "The proposed design drops source text or data: " + missing.slice(0, 8).map((item) => '"' + item + '"').join(", ") +
        (missing.length > 8 ? ", and " + (missing.length - 8) + " more" : "") + ". Preserve the source content unless the user explicitly requested that specific change."
    );
  }
  if (missingCriticalValues.length) {
    add(
      "missing-source-content",
      "high",
      "Critical source values or identifiers are missing: " + missingCriticalValues.slice(0, 8).join(", ") +
        ". Copy these from the selected frame; do not invent replacement financial data."
    );
  }

  const checkContainer = (
    container: RecordLike,
    children: RecordLike[],
    width: number,
    height: number,
    inheritedBackground: string | null,
    path: string,
  ) => {
    const isFrame = container.type === "FRAME";
    const name = typeof container.name === "string" ? container.name : "unnamed frame";
    const layoutMode = String(container.layoutMode || "NONE").toUpperCase();
    const flowChildren = children.filter((child) => child.layoutPositioning !== "ABSOLUTE");
    const childWidthLimit = width - padding(container, "paddingLeft") - padding(container, "paddingRight");
    const fixedVertical = layoutMode === "VERTICAL" &&
      container.primaryAxisSizingMode !== "AUTO" && container.layoutSizingVertical !== "HUG";
    const fixedHorizontal = layoutMode === "HORIZONTAL" &&
      container.primaryAxisSizingMode !== "AUTO" && container.layoutSizingHorizontal !== "HUG";

    if (isFrame && container.noFill !== true && hexToRgb(container.color) === null) {
      add(
        "implicit-frame-fill",
        "medium",
        '"' + name + '" has no explicit surface fill or noFill:true. Set its intended color or make the structural frame transparent to avoid default white surfaces.'
      );
    }

    if (fixedVertical) {
      const required = padding(container, "paddingTop") + padding(container, "paddingBottom") +
        flowChildren.reduce((sum, child) => sum + dimension(child, "height"), 0) +
        Math.max(0, flowChildren.length - 1) *
          (typeof container.itemSpacing === "number" && Number.isFinite(container.itemSpacing) ? Number(container.itemSpacing) : 0);
      if (required > height + 2) {
        add(
          "fixed-layout-overflow",
          "high",
          '"' + name + '" is a fixed-height vertical Auto Layout frame (' + Math.round(height) +
            ' px) but its direct content needs about ' + Math.ceil(required) +
            ' px. Increase the frame height, reduce spacing, or fix child sizing before writing to Figma.'
        );
      }
    } else if (fixedHorizontal) {
      const required = padding(container, "paddingLeft") + padding(container, "paddingRight") +
        flowChildren.reduce((sum, child) => sum + dimension(child, "width"), 0) +
        Math.max(0, flowChildren.length - 1) *
          (typeof container.itemSpacing === "number" && Number.isFinite(container.itemSpacing) ? Number(container.itemSpacing) : 0);
      if (required > width + 2) {
        add(
          "fixed-layout-overflow",
          "high",
          '"' + name + '" is a fixed-width horizontal Auto Layout frame (' + Math.round(width) +
            ' px) but its direct content needs about ' + Math.ceil(required) +
            ' px. Reduce gaps/padding or resize the frame.'
        );
      }
    }

    children.forEach((child) => {
      const childName = typeof child.name === "string" ? child.name : String(child.type || "layer");
      // Positions are ignored for normal Auto Layout children. They do matter
      // for free-positioned children and intentional absolute overlays.
      if (layoutMode === "NONE" && child.layoutPositioning !== "ABSOLUTE") {
        const x = typeof child.x === "number" ? Number(child.x) : 0;
        const y = typeof child.y === "number" ? Number(child.y) : 0;
        const cw = dimension(child, "width");
        const ch = dimension(child, "height");
        if (x < -1 || y < -1 || x + cw > width + 2 || y + ch > height + 2) {
          add(
            "child-out-of-bounds",
            "high",
            '"' + path + "/" + childName + '" extends outside its ' + Math.round(width) + "×" + Math.round(height) +
              " px parent. Keep text and actions inside the visible frame bounds."
          );
        }
      }
      if (["VERTICAL", "HORIZONTAL", "GRID"].includes(layoutMode) &&
          child.layoutPositioning !== "ABSOLUTE" && dimension(child, "width") > childWidthLimit + 2) {
        add(
          "child-out-of-bounds",
          "high",
          '"' + path + "/" + childName + '" is wider than its Auto Layout content area. Reduce its width or correct the parent padding/sizing.'
        );
      }

      const background = child.type === "FRAME" && hexToRgb(child.color)
        ? String(child.color)
        : inheritedBackground;
      if (child.type === "TEXT" && typeof child.color === "string" && background) {
        const ratio = contrastRatio(child.color, background);
        if (ratio !== null && ratio < 4.5) {
          add(
            "low-contrast",
            "high",
            '"' + childName + '" has a ' + ratio.toFixed(2) +
              ":1 text/background contrast ratio, below the 4.5:1 preflight threshold. Use a more readable foreground or surface color."
          );
        }
      }
      checkContainer(
        child,
        childrenOf(child),
        dimension(child, "width"),
        dimension(child, "height"),
        background,
        path + "/" + childName
      );
    });
  };

  const root = {
    type: "FRAME",
    name: typeof planFrame.name === "string" ? planFrame.name : "generated frame",
    width: dimension(planFrame, "width"),
    height: dimension(planFrame, "height"),
    layoutMode: typeof planFrame.layoutMode === "string" ? planFrame.layoutMode : "NONE",
    itemSpacing: planFrame.itemSpacing,
    paddingLeft: planFrame.paddingLeft,
    paddingRight: planFrame.paddingRight,
    paddingTop: planFrame.paddingTop,
    paddingBottom: planFrame.paddingBottom,
    primaryAxisSizingMode: planFrame.primaryAxisSizingMode,
    counterAxisSizingMode: planFrame.counterAxisSizingMode,
    color: planFrame.backgroundColor,
    noFill: false,
  } as RecordLike;

  checkContainer(
    root,
    outputNodes,
    dimension(planFrame, "width"),
    dimension(planFrame, "height"),
    typeof planFrame.backgroundColor === "string" ? planFrame.backgroundColor : null,
    String(root.name)
  );

  const weight = findings.reduce((sum, finding) => sum + (finding.severity === "high" ? 30 : 8), 0);
  const score = Math.max(0, 100 - weight);
  return { passed: findings.length === 0, score, findings };
}

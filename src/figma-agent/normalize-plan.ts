function normalizeColor(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase();
    if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) return ("#" + trimmed.slice(1).split("").map((part) => part + part).join("")).toUpperCase();
    const rgb = trimmed.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
    if (rgb) return "#" + rgb.slice(1, 4).map((part) => Math.max(0, Math.min(255, Number(part))).toString(16).padStart(2, "0")).join("").toUpperCase();
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const candidate of [record.hex, record.value, record.color, record.fill, record.backgroundColor]) {
    if (candidate !== value) {
      const normalized = normalizeColor(candidate);
      if (normalized) return normalized;
    }
  }
  if (typeof record.r === "number" && typeof record.g === "number" && typeof record.b === "number") {
    const channel = (n: number) => Math.round(Math.max(0, Math.min(1, n > 1 ? n / 255 : n)) * 255).toString(16).padStart(2, "0");
    return ("#" + channel(record.r) + channel(record.g) + channel(record.b)).toUpperCase();
  }
  return null;
}

function normalizeElementType(value: unknown, item: Record<string, unknown>): "RECTANGLE" | "ELLIPSE" | "TEXT" | "LINE" | "FRAME" | "POLYGON" | "STAR" {
  const raw = typeof value === "string" ? value.trim().toUpperCase().replace(/[ -]+/g, "_") : "";
  const aliases: Record<string, "RECTANGLE" | "ELLIPSE" | "TEXT" | "LINE" | "FRAME" | "POLYGON" | "STAR"> = {
    RECT: "RECTANGLE", RECTANGLE: "RECTANGLE", SHAPE: "RECTANGLE", BUTTON: "FRAME", CARD: "FRAME", CONTAINER: "FRAME", FRAME: "FRAME", GROUP: "FRAME",
    ELLIPSE: "ELLIPSE", CIRCLE: "ELLIPSE", DOT: "ELLIPSE", AVATAR: "ELLIPSE",
    TEXT: "TEXT", LABEL: "TEXT", HEADING: "TEXT", PARAGRAPH: "TEXT", CAPTION: "TEXT", BODY: "TEXT", TYPOGRAPHY: "TEXT",
    LINE: "LINE", DIVIDER: "LINE", SEPARATOR: "LINE",
    POLYGON: "POLYGON", TRIANGLE: "POLYGON", STAR: "STAR",
  };
  if (aliases[raw]) return aliases[raw];
  if (["text", "content", "characters", "label"].some((key) => typeof item[key] === "string")) return "TEXT";
  if (Array.isArray(item.children)) return "FRAME";
  return "RECTANGLE";
}


type RepairGeometryRecord = Record<string, unknown>;

function isRepairGeometryRecord(value: unknown): value is RepairGeometryRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function repairGeometryChildren(node: RepairGeometryRecord): RepairGeometryRecord[] {
  return Array.isArray(node.children) ? node.children.filter(isRepairGeometryRecord) : [];
}

function repairGeometryNumber(node: RepairGeometryRecord, key: string, fallback = 0): number {
  const value = node[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function estimateWrappedTextHeight(node: RepairGeometryRecord): number {
  if (node.type !== "TEXT" || typeof node.text !== "string") return repairGeometryNumber(node, "height", 1);
  const fontSize = Math.max(8, repairGeometryNumber(node, "fontSize", 14));
  const width = Math.max(1, repairGeometryNumber(node, "width", 1));
  const charsPerLine = Math.max(1, Math.floor(width / (fontSize * 0.52)));
  const lines = node.text.split(/\r?\n/).reduce((count, line) =>
    count + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
  return Math.max(repairGeometryNumber(node, "height", 1), Math.ceil(lines * fontSize * 1.35));
}

/**
 * Repairs model-authored geometry deterministically before the strict quality
 * gate. It keeps every node and exact text, fits over-wide Auto Layout children,
 * wraps text after narrowing, and lets nested vertical content grow instead of
 * clipping it inside fixed-height cards.
 */
export function repairPlanGeometry(value: unknown): unknown {
  if (!isRepairGeometryRecord(value)) return value;
  const plan: RepairGeometryRecord = { ...value };
  const frame = isRepairGeometryRecord(plan.frame) ? { ...plan.frame } : {};
  const elements = Array.isArray(plan.elements)
    ? plan.elements.filter(isRepairGeometryRecord).map(node => ({ ...node }))
    : [];
  if (!elements.length) return plan;

  const fitWidth = (child: RepairGeometryRecord, width: number, mode: string) => {
    const nextWidth = Math.max(1, Math.floor(width));
    if (repairGeometryNumber(child, "width", 1) <= nextWidth + 1) return;
    child.width = nextWidth;
    if (child.type === "TEXT") {
      // Wrapped Figma text needs a concrete width with HEIGHT auto-resize.
      child.layoutSizingHorizontal = "FIXED";
      child.textAutoResize = "HEIGHT";
      child.height = estimateWrappedTextHeight(child);
    } else if (mode === "VERTICAL" && child.layoutPositioning !== "ABSOLUTE") {
      child.layoutSizingHorizontal = "FILL";
    } else {
      child.layoutSizingHorizontal = "FIXED";
    }
  };

  const repairNode = (node: RepairGeometryRecord, isViewport = false, depth = 0): void => {
    if (depth > 8) return;
    const children = repairGeometryChildren(node);
    if (!children.length) {
      if (node.type === "TEXT") {
        node.height = Math.max(1, repairGeometryNumber(node, "height", 1));
      }
      return;
    }

    const mode = String(node.layoutMode || "NONE").toUpperCase();
    const width = Math.max(1, repairGeometryNumber(node, "width", repairGeometryNumber(frame, "width", 360)));
    const height = Math.max(1, repairGeometryNumber(node, "height", 1));
    const padL = Math.max(0, repairGeometryNumber(node, "paddingLeft"));
    const padR = Math.max(0, repairGeometryNumber(node, "paddingRight"));
    const padT = Math.max(0, repairGeometryNumber(node, "paddingTop"));
    const padB = Math.max(0, repairGeometryNumber(node, "paddingBottom"));
    const gap = Math.max(0, repairGeometryNumber(node, "itemSpacing"));
    const flow = children.filter(child => child.layoutPositioning !== "ABSOLUTE");

    if (mode === "VERTICAL") {
      const contentWidth = Math.max(1, width - padL - padR);
      for (const child of flow) fitWidth(child, contentWidth, mode);
    } else if (mode === "HORIZONTAL") {
      const contentBudget = Math.max(1, width - padL - padR - Math.max(0, flow.length - 1) * gap);
      const currentTotal = flow.reduce((sum, child) => sum + Math.max(1, repairGeometryNumber(child, "width", 1)), 0);
      if (currentTotal > contentBudget + 1) {
        // Preserve the horizontal relationship but proportionally allocate the real
        // content width. Text nodes then wrap rather than collide or get clipped.
        const scale = contentBudget / currentTotal;
        const widths = flow.map(child => Math.max(1, Math.floor(repairGeometryNumber(child, "width", 1) * scale)));
        let excess = widths.reduce((sum, next) => sum + next, 0) - contentBudget;
        if (excess > 0) {
          const order = widths.map((next, index) => ({ next, index })).sort((a, b) => b.next - a.next);
          for (const entry of order) {
            if (excess <= 0) break;
            const canReduce = Math.max(0, widths[entry.index] - 1);
            const reduceBy = Math.min(canReduce, excess);
            widths[entry.index] -= reduceBy;
            excess -= reduceBy;
          }
        }
        flow.forEach((child, index) => fitWidth(child, widths[index], mode));
        // Frames also use fixed allocated widths here; FILL could re-distribute
        // uneven columns and invalidate the geometry that was just repaired.
        flow.filter(child => child.type !== "TEXT").forEach(child => {
          if (child.layoutPositioning !== "ABSOLUTE") child.layoutSizingHorizontal = "FIXED";
        });
      }
    } else if (mode === "NONE") {
      // Free-positioned siblings retain their intended coordinates, but normal
      // children cannot extend beyond the actual parent width.
      for (const child of children) {
        if (child.layoutPositioning === "ABSOLUTE") continue;
        const x = repairGeometryNumber(child, "x");
        if (x + repairGeometryNumber(child, "width", 1) > width + 1) {
          fitWidth(child, Math.max(1, width - Math.max(0, x)), mode);
        }
      }
    }

    // Descendants must be repaired before parent heights are recomputed.
    for (const child of children) repairNode(child, false, depth + 1);

    if (mode === "VERTICAL" && !isViewport) {
      const requiredHeight = padT + padB +
        flow.reduce((sum, child) => sum + Math.max(1, repairGeometryNumber(child, "height", 1)), 0) +
        Math.max(0, flow.length - 1) * gap;
      if (requiredHeight > height + 1) {
        node.height = Math.min(4096, Math.ceil(requiredHeight));
        node.primaryAxisSizingMode = "AUTO";
      }
    } else if (mode === "HORIZONTAL") {
      const requiredHeight = padT + padB +
        flow.reduce((max, child) => Math.max(max, repairGeometryNumber(child, "height", 1)), 0);
      if (requiredHeight > height + 1) {
        node.height = Math.min(4096, Math.ceil(requiredHeight));
        node.counterAxisSizingMode = "AUTO";
      }
    }
  };

  const root = {
    ...frame,
    type: "FRAME",
    name: typeof frame.name === "string" ? frame.name : "Generated frame",
    width: repairGeometryNumber(frame, "width", 360),
    height: repairGeometryNumber(frame, "height", 800),
  };
  repairNode({ ...root, children: elements }, true);
  plan.frame = frame;
  plan.elements = elements;
  return plan;
}

export function normalizePlan(value: unknown, canvas: Record<string, unknown>): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  const rawFrameValue = root.frame ?? root.screen ?? root.container ?? root.canvas;
  const rawFrame = rawFrameValue && typeof rawFrameValue === "object" && !Array.isArray(rawFrameValue)
    ? rawFrameValue as Record<string, unknown>
    : {};
  const sourceNodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
  const sourceNode = sourceNodes[0] && typeof sourceNodes[0] === "object" && !Array.isArray(sourceNodes[0])
    ? sourceNodes[0] as Record<string, unknown>
    : {};
  const frameWidth = Number(rawFrame.width ?? rawFrame.frameWidth ?? sourceNode.width ?? 393);
  const frameHeight = Number(rawFrame.height ?? rawFrame.frameHeight ?? sourceNode.height ?? 852);
  const sourceIsComponent = ["COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP"].includes(String(sourceNode.type || "").toUpperCase()) ||
    (frameWidth > 0 && frameWidth <= 520 && frameHeight > 0 && frameHeight <= 560 &&
      /\\b(card|component|widget|tile|row|button|panel|item|summary|breakdown|loan)\\b/i.test(String(sourceNode.name || "")) &&
      !/\\b(screen|page|dashboard|flow)\\b/i.test(String(sourceNode.name || "")));
  const requestedRootLayout = String(rawFrame.layoutMode ?? rawFrame.layout ?? "VERTICAL").trim().toUpperCase();
  const frame = {
    name: String(rawFrame.name ?? rawFrame.title ?? root.frameName ?? "UX Direct Variation").trim().slice(0, 80) || "UX Direct Variation",
    width: Math.max(280, Math.min(1440, Math.round(Number.isFinite(frameWidth) ? frameWidth : 393))),
    height: Math.max(360, Math.min(4096, Math.round(Number.isFinite(frameHeight) ? frameHeight : 852))),
    backgroundColor: normalizeColor(rawFrame.backgroundColor ?? rawFrame.background ?? rawFrame.fill ?? rawFrame.color)
      || (Array.isArray(sourceNode.fillColors) && typeof sourceNode.fillColors[0] === "string" ? normalizeColor(sourceNode.fillColors[0]) : null)
      || "#F7F8FA",
    layoutMode: requestedRootLayout === "HORIZONTAL" ? "HORIZONTAL" : requestedRootLayout === "NONE" ? "NONE" : "VERTICAL",
    itemSpacing: typeof rawFrame.itemSpacing === "number" && Number.isFinite(rawFrame.itemSpacing)
      ? Math.max(0, Math.min(160, rawFrame.itemSpacing)) : (sourceIsComponent ? 8 : 16),
    paddingLeft: typeof rawFrame.paddingLeft === "number" && Number.isFinite(rawFrame.paddingLeft)
      ? Math.max(0, Math.min(160, rawFrame.paddingLeft)) : (sourceIsComponent ? 12 : 16),
    paddingRight: typeof rawFrame.paddingRight === "number" && Number.isFinite(rawFrame.paddingRight)
      ? Math.max(0, Math.min(160, rawFrame.paddingRight)) : (sourceIsComponent ? 12 : 16),
    paddingTop: typeof rawFrame.paddingTop === "number" && Number.isFinite(rawFrame.paddingTop)
      ? Math.max(0, Math.min(160, rawFrame.paddingTop)) : (sourceIsComponent ? 12 : 16),
    paddingBottom: typeof rawFrame.paddingBottom === "number" && Number.isFinite(rawFrame.paddingBottom)
      ? Math.max(0, Math.min(160, rawFrame.paddingBottom)) : (sourceIsComponent ? 12 : 16),
    primaryAxisAlignItems: ["MIN", "MAX", "CENTER", "SPACE_BETWEEN"].includes(String(rawFrame.primaryAxisAlignItems || "").toUpperCase())
      ? String(rawFrame.primaryAxisAlignItems).toUpperCase() : "MIN",
    counterAxisAlignItems: ["MIN", "MAX", "CENTER", "BASELINE"].includes(String(rawFrame.counterAxisAlignItems || "").toUpperCase())
      ? String(rawFrame.counterAxisAlignItems).toUpperCase() : "MIN",
    primaryAxisSizingMode: rawFrame.primaryAxisSizingMode === "AUTO" ? "AUTO" : "FIXED",
    counterAxisSizingMode: rawFrame.counterAxisSizingMode === "AUTO" ? "AUTO" : "FIXED",
  };
  const rootBackgroundChannels = frame.backgroundColor.slice(1).match(/.{2}/g)?.map((channel) => Number.parseInt(channel, 16)) || [247, 248, 250];
  const darkCanvas = (0.2126 * rootBackgroundChannels[0] + 0.7152 * rootBackgroundChannels[1] + 0.0722 * rootBackgroundChannels[2]) < 128;
  const inputElements = root.elements ?? root.layers ?? root.nodes ?? root.children;
  if (!Array.isArray(inputElements)) {
    return { summary: root.summary ?? root.description ?? "A UX Direct native design variation.", frame, elements: inputElements };
  }

  let visited = 0;
  function normalizeNode(raw: unknown, index: number, depth: number): Record<string, unknown> | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || depth > 4 || visited >= 75) return null;
    const item = raw as Record<string, unknown>;
    visited += 1;
    const type = normalizeElementType(item.type ?? item.kind ?? item.elementType ?? item.nodeType, item);
    const textValue = item.text ?? item.content ?? item.characters ?? item.value;
    const text = typeof textValue === "string" ? textValue.slice(0, 1800) : undefined;
    const fallbackName = text ? "Text · " + text.replace(/\s+/g, " ").slice(0, 42) : type.charAt(0) + type.slice(1).toLowerCase() + " " + (index + 1);
    const nameValue = item.name ?? item.layerName ?? item.label ?? item.title ?? item.id;
    const name = (typeof nameValue === "string" && nameValue.trim() ? nameValue.trim() : fallbackName).slice(0, 80);
    const explicitX = item.x ?? item.left;
    const explicitY = item.y ?? item.top;
    const widthValue = item.width ?? item.w;
    const heightValue = item.height ?? item.h;
    const width = typeof widthValue === "number" && Number.isFinite(widthValue)
      ? widthValue : type === "FRAME" ? Math.max(1, frame.width - 32) : type === "TEXT" ? 280 : 160;
    const height = typeof heightValue === "number" && Number.isFinite(heightValue)
      ? heightValue : type === "FRAME" ? 100 : type === "TEXT" ? 34 : 60;
    const x = Math.max(-1000, Math.min(5000, typeof explicitX === "number" && Number.isFinite(explicitX) ? explicitX : 16));
    const y = Math.max(-1000, Math.min(5000, typeof explicitY === "number" && Number.isFinite(explicitY)
      ? explicitY : type === "FRAME" ? 16 + index * 120 : 16 + index * 44));
    const color = normalizeColor(item.color ?? item.fill ?? item.backgroundColor ?? item.background ?? item.fillColor);
    const strokeColor = normalizeColor(item.strokeColor ?? item.stroke ?? item.borderColor);
    const fontRaw = item.font && typeof item.font === "object" && !Array.isArray(item.font) ? item.font as Record<string, unknown> : {};
    const normalized: Record<string, unknown> = {
      type, name, x, y,
      width: Math.max(1, Math.min(4096, width)),
      height: Math.max(1, Math.min(4096, height)),
    };
    if (text !== undefined && type === "TEXT") normalized.text = text;
    const fontSizeValue = item.fontSize ?? item.textSize;
    if (typeof fontSizeValue === "number" && Number.isFinite(fontSizeValue)) normalized.fontSize = Math.max(8, Math.min(96, fontSizeValue));
    if (typeof item.fontFamily === "string" || typeof fontRaw.family === "string") normalized.fontFamily = String(item.fontFamily ?? fontRaw.family).trim().slice(0, 100) || "Inter";
    if (typeof item.fontStyle === "string" || typeof fontRaw.style === "string" || typeof fontRaw.weight === "string") normalized.fontStyle = String(item.fontStyle ?? fontRaw.style ?? fontRaw.weight).trim().slice(0, 100) || "Regular";
    if (color) normalized.color = color;
    else if (type === "FRAME" && typeof item.noFill !== "boolean") {
      const semanticSurface = /\b(card|panel|surface|container|summary|breakdown)\b/i.test(name) &&
        !/\b(wrapper|layout|group|stack)\b/i.test(name);
      const activeControl = /\b(active|selected|current)\b/i.test(name) &&
        /\b(tab|chip|pill|badge)\b/i.test(name);
      if (activeControl) normalized.color = darkCanvas ? "#24483F" : "#DDF4EC";
      else if (semanticSurface) normalized.color = darkCanvas ? "#202124" : "#FFFFFF";
      else normalized.noFill = true;
    }
    if (strokeColor) normalized.strokeColor = strokeColor;
    if (typeof item.noFill === "boolean") normalized.noFill = item.noFill;
    const rawArcData = item.arcData && typeof item.arcData === "object" && !Array.isArray(item.arcData)
      ? item.arcData as Record<string, unknown> : null;
    if (type === "ELLIPSE" && rawArcData &&
        typeof rawArcData.startingAngle === "number" && Number.isFinite(rawArcData.startingAngle) &&
        typeof rawArcData.endingAngle === "number" && Number.isFinite(rawArcData.endingAngle) &&
        typeof rawArcData.innerRadius === "number" && Number.isFinite(rawArcData.innerRadius) &&
        rawArcData.endingAngle > rawArcData.startingAngle) {
      normalized.arcData = {
        startingAngle: Math.max(-Math.PI * 2, Math.min(Math.PI * 2, rawArcData.startingAngle)),
        endingAngle: Math.max(-Math.PI * 2, Math.min(Math.PI * 2, rawArcData.endingAngle)),
        innerRadius: Math.max(0, Math.min(1, rawArcData.innerRadius)),
      };
    }
    const aliases: Array<[string, string]> = [
      ["strokeWeight", "strokeWeight"], ["opacity", "opacity"], ["cornerRadius", "cornerRadius"],
      ["clipsContent", "clipsContent"], ["layoutMode", "layoutMode"], ["layoutWrap", "layoutWrap"],
      ["layoutSizingHorizontal", "layoutSizingHorizontal"], ["layoutSizingVertical", "layoutSizingVertical"],
      ["layoutPositioning", "layoutPositioning"], ["layoutGrow", "layoutGrow"], ["layoutAlign", "layoutAlign"],
      ["horizontalConstraint", "horizontalConstraint"], ["verticalConstraint", "verticalConstraint"],
      ["itemSpacing", "itemSpacing"], ["paddingLeft", "paddingLeft"], ["paddingRight", "paddingRight"],
      ["paddingTop", "paddingTop"], ["paddingBottom", "paddingBottom"],
      ["primaryAxisAlignItems", "primaryAxisAlignItems"], ["counterAxisAlignItems", "counterAxisAlignItems"],
      ["primaryAxisSizingMode", "primaryAxisSizingMode"], ["counterAxisSizingMode", "counterAxisSizingMode"],
      ["textAlignHorizontal", "textAlignHorizontal"], ["textAlignVertical", "textAlignVertical"], ["textAutoResize", "textAutoResize"],
      ["lineHeight", "lineHeight"], ["letterSpacing", "letterSpacing"],
      ["textCase", "textCase"], ["textDecoration", "textDecoration"],
      ["paintStyleId", "paintStyleId"], ["textStyleId", "textStyleId"], ["effectStyleId", "effectStyleId"], ["gridStyleId", "gridStyleId"],
      ["shadowColor", "shadowColor"],
      ["shadowBlur", "shadowBlur"], ["shadowX", "shadowX"], ["shadowY", "shadowY"], ["shadowSpread", "shadowSpread"],
    ];
    for (const [sourceKey, targetKey] of aliases) {
      const rawValue = item[sourceKey] ?? (sourceKey === "cornerRadius" ? item.radius ?? item.borderRadius : undefined);
      if (rawValue === undefined) continue;
      if (sourceKey === "shadowColor") {
        const normalizedColor = normalizeColor(rawValue);
        if (normalizedColor) normalized[targetKey] = normalizedColor;
      } else if ((sourceKey === "lineHeight" || sourceKey === "letterSpacing") && rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
        const metric = rawValue as Record<string, unknown>;
        const unit = metric.unit;
        const value = metric.value;
        if ((unit === "PIXELS" || unit === "PERCENT") && typeof value === "number" && Number.isFinite(value)) {
          normalized[targetKey] = { unit, value: sourceKey === "lineHeight" ? Math.max(1, Math.min(500, value)) : Math.max(-100, Math.min(500, value)) };
        }
      } else if (sourceKey === "clipsContent" && typeof rawValue === "boolean") normalized[targetKey] = rawValue;
      else if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
        const ranges: Record<string, [number, number]> = {
          strokeWeight: [0, 20], opacity: [0, 1], cornerRadius: [0, 128], layoutGrow: [0, 1],
          itemSpacing: [0, 160], paddingLeft: [0, 160], paddingRight: [0, 160],
          paddingTop: [0, 160], paddingBottom: [0, 160], shadowBlur: [0, 80],
          shadowX: [-30, 30], shadowY: [-30, 30], shadowSpread: [-30, 30],
        };
        const range = ranges[targetKey];
        normalized[targetKey] = range ? Math.max(range[0], Math.min(range[1], rawValue)) : rawValue;
      } else if (typeof rawValue === "string") {
        const enumKeys = new Set([
          "layoutMode", "layoutWrap", "layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning", "layoutAlign",
          "horizontalConstraint", "verticalConstraint", "primaryAxisAlignItems", "counterAxisAlignItems",
          "primaryAxisSizingMode", "counterAxisSizingMode", "textAlignHorizontal", "textAlignVertical",
          "textAutoResize", "textCase", "textDecoration",
        ]);
        let enumValue = rawValue.trim().toUpperCase().replace(/[ -]+/g, "_");
        if (targetKey === "textCase") {
          if (enumValue === "UPPERCASE" || enumValue === "UPPER_CASE") enumValue = "UPPER";
          if (enumValue === "LOWERCASE" || enumValue === "LOWER_CASE") enumValue = "LOWER";
          if (enumValue === "TITLE_CASE") enumValue = "TITLE";
        }
        normalized[targetKey] = enumKeys.has(targetKey) ? enumValue : rawValue.trim().slice(0, 100);
      }
    }
    if (Array.isArray(item.children) && depth < 4) {
      const children: Record<string, unknown>[] = [];
      for (const [childIndex, child] of item.children.slice(0, 35).entries()) {
        const nested = normalizeNode(child, childIndex, depth + 1);
        if (nested) children.push(nested);
        if (visited >= 75) break;
      }
      if (children.length) normalized.children = children;
    }
    return normalized;
  }

  let normalized = inputElements.map((item, index) => normalizeNode(item, index, 0)).filter((item): item is Record<string, unknown> => !!item);

  // Rebuild the source card boundary when a plan incorrectly separates its summary,
  // breakdown and badge into unrelated top-level siblings.
  function findSourceCompoundCard(nodes: unknown[], depth = 0): Record<string, unknown> | null {
    if (depth > 5) return null;
    for (const value of nodes) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const source = value as Record<string, unknown>;
      const children = Array.isArray(source.children) ? source.children : [];
      const names = children.map((child) => child && typeof child === "object" && !Array.isArray(child)
        ? String((child as Record<string, unknown>).name || "") : "");
      if (children.length && names.some((name) => /summary/i.test(name)) &&
          names.some((name) => /break.?up|break.?down|loan.?wise|details/i.test(name))) return source;
      const nested = findSourceCompoundCard(children, depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  const sourceCompoundCard = findSourceCompoundCard(sourceNodes);
  if (sourceCompoundCard) {
    const summaryIndex = normalized.findIndex((node) => node.type === "FRAME" &&
      /summary|primary loan/i.test(String(node.name || "")) && Array.isArray(node.children));
    const breakdownIndex = normalized.findIndex((node, index) => index !== summaryIndex && node.type === "FRAME" &&
      /break.?up|break.?down|loan.?wise|supporting details/i.test(String(node.name || "")) && Array.isArray(node.children));
    if (summaryIndex >= 0 && breakdownIndex >= 0) {
      const summary = normalized[summaryIndex], breakdown = normalized[breakdownIndex];
      const summaryX = Number(summary.x) || 0, summaryY = Number(summary.y) || 0;
      const breakdownX = Number(breakdown.x) || 0, breakdownY = Number(breakdown.y) || 0;
      const summaryW = Number(summary.width) || 0, summaryH = Number(summary.height) || 0;
      const breakdownW = Number(breakdown.width) || 0, breakdownH = Number(breakdown.height) || 0;
      const gap = breakdownY - (summaryY + summaryH);
      const aligned = Math.abs(summaryX - breakdownX) <= 24 && Math.abs(summaryW - breakdownW) <= 36;
      if (aligned && gap >= -24 && gap <= 36) {
        const left = Math.min(summaryX, breakdownX), top = Math.min(summaryY, breakdownY);
        const right = Math.max(summaryX + summaryW, breakdownX + breakdownW);
        const bottom = Math.max(summaryY + summaryH, breakdownY + breakdownH);
        const baseIndices = [summaryIndex, breakdownIndex];
        const badges = normalized.map((node, index) => ({ node, index })).filter(({ node, index }) => {
          if (baseIndices.includes(index) || node.type !== "FRAME" ||
              !/status.?badge|current.?badge|badge.?status/i.test(String(node.name || ""))) return false;
          const x = Number(node.x) || 0, y = Number(node.y) || 0;
          const w = Number(node.width) || 0, h = Number(node.height) || 0;
          return w <= 128 && h <= 36 && x >= left && x + w <= right + 8 && y >= top - 6 && y <= top + 34;
        });
        const toLocal = (node: Record<string, unknown>) => ({
          ...node, x: Math.round((Number(node.x) || 0) - left), y: Math.round((Number(node.y) || 0) - top),
        });
        const cardChildren = [toLocal(summary), toLocal(breakdown), ...badges.map(({ node }) => toLocal(node))];
        const nativeCardName = String(sourceCompoundCard.name || "Active loan card").slice(0, 58);
        const outerCard: Record<string, unknown> = {
          type: "FRAME", name: nativeCardName + " — variation",
          x: left, y: top,
          width: Math.max(1, Math.min(frame.width, right - left)),
          height: Math.max(1, Math.min(frame.height, bottom - top)),
          noFill: true, strokeColor: "#494949", strokeWeight: 1, cornerRadius: 14,
          clipsContent: false, children: cardChildren,
        };
        const removed = new Set([summaryIndex, breakdownIndex, ...badges.map(({ index }) => index)]);
        normalized = normalized.filter((_node, index) => !removed.has(index));
        normalized.push(outerCard);
      }
    }
  }

  const countTree = (nodes: Record<string, unknown>[]): number => nodes.reduce((count, node) =>
    count + 1 + (Array.isArray(node.children) ? countTree(node.children as Record<string, unknown>[]) : 0), 0);
  const countFrameGroups = (nodes: Record<string, unknown>[]): number => nodes.reduce((count, node) => {
    const children = Array.isArray(node.children) ? node.children as Record<string, unknown>[] : [];
    return count + (node.type === "FRAME" && children.length > 0 ? 1 : 0) + countFrameGroups(children);
  }, 0);
  const namedFrameGroups = countFrameGroups(normalized);
  const alreadyStructured = normalized.length >= 3 && normalized.length <= 8 &&
    normalized.every((node) => node.type === "FRAME" && Array.isArray(node.children) && node.children.length > 0) &&
    namedFrameGroups >= 4 && countTree(normalized) <= 80;

  if (!alreadyStructured) {
    const allLeaves: Array<Record<string, unknown>> = [];
    const collect = (nodes: Record<string, unknown>[]) => {
      for (const node of nodes) {
        const children = Array.isArray(node.children) ? node.children as Record<string, unknown>[] : [];
        if (children.length) {
          allLeaves.push(node);
          // Preserve a model-authored component frame as one leaf rather than destroying its nested contents.
        } else {
          allLeaves.push(node);
        }
      }
    };
    collect(normalized);
    const sourceName = String(sourceNode.name ?? "");
    const sourceType = String(sourceNode.type ?? "").toUpperCase();
    const sourceWidth = Number(sourceNode.width) || 0;
    const sourceHeight = Number(sourceNode.height) || 0;
    const componentScope = ["COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP"].includes(sourceType) ||
      (sourceWidth > 0 && sourceWidth <= 520 && sourceHeight > 0 && sourceHeight <= 560 &&
        /\b(card|component|widget|tile|row|button|panel|item|summary|breakdown|loan)\b/i.test(sourceName) &&
        !/\b(screen|page|dashboard|flow)\b/i.test(sourceName));
    const bands = componentScope ? [
      { name: "Card header & status", start: 0, end: 0.23 },
      { name: "Primary loan information", start: 0.23, end: 0.48 },
      { name: "Progress & key indicators", start: 0.48, end: 0.68 },
      { name: "Breakdown & supporting details", start: 0.68, end: 0.88 },
      { name: "Actions & secondary metadata", start: 0.88, end: 1.5 },
    ] : [
      { name: "Header & navigation", start: 0, end: 0.14 },
      { name: "Status & section tabs", start: 0.14, end: 0.30 },
      { name: "Primary information", start: 0.30, end: 0.55 },
      { name: "Details & breakdown", start: 0.55, end: 0.78 },
      { name: "Actions & support", start: 0.78, end: 1.5 },
    ];
    const isFullScreenBackdrop = (item: Record<string, unknown>) =>
      item.type === "RECTANGLE" && (Number(item.x) || 0) <= 2 && (Number(item.y) || 0) <= 2 &&
      (Number(item.width) || 0) >= frame.width * 0.94 && (Number(item.height) || 0) >= frame.height * 0.9;
    const eligibleLeaves = allLeaves.filter((item) => !isFullScreenBackdrop(item));
    const buckets: Array<Array<Record<string, unknown>>> = bands.map((band) =>
      eligibleLeaves.filter((item) => {
        const centerY = (Number(item.y) || 0) + (Number(item.height) || 0) / 2;
        return centerY / frame.height >= band.start && centerY / frame.height < band.end;
      }).slice(0, 30)
    );
    // Flat model plans sometimes place most nodes in one region. Rebalance only when necessary so each semantic section gets a unique child without duplicating any Figma layer.
    for (let emptyIndex = 0; emptyIndex < buckets.length; emptyIndex += 1) {
      if (buckets[emptyIndex].length) continue;
      const targetY = frame.height * (bands[emptyIndex].start + bands[emptyIndex].end) / 2;
      let donorIndex = -1, nodeIndex = -1, bestDistance = Number.POSITIVE_INFINITY;
      for (let groupIndex = 0; groupIndex < buckets.length; groupIndex += 1) {
        if (buckets[groupIndex].length <= 1) continue;
        for (let candidateIndex = 0; candidateIndex < buckets[groupIndex].length; candidateIndex += 1) {
          const candidate = buckets[groupIndex][candidateIndex];
          const centerY = (Number(candidate.y) || 0) + (Number(candidate.height) || 0) / 2;
          const distance = Math.abs(centerY - targetY);
          if (distance < bestDistance) { bestDistance = distance; donorIndex = groupIndex; nodeIndex = candidateIndex; }
        }
      }
      if (donorIndex >= 0 && nodeIndex >= 0) {
        const moved = buckets[donorIndex].splice(nodeIndex, 1)[0];
        buckets[emptyIndex].push(moved);
      }
    }
    const groups = bands.map((band, index) => {
      const bucket = buckets[index];
      const minX = bucket.length ? Math.max(0, Math.min(...bucket.map((item) => Number(item.x) || 0))) : 16;
      const minY = bucket.length ? Math.max(0, Math.min(...bucket.map((item) => Number(item.y) || 0))) : Math.round(frame.height * band.start);
      const maxX = bucket.length ? Math.max(...bucket.map((item) => (Number(item.x) || 0) + (Number(item.width) || 1))) : frame.width - 16;
      const maxY = bucket.length ? Math.max(...bucket.map((item) => (Number(item.y) || 0) + (Number(item.height) || 1))) : minY + 1;
      const children = bucket.map((item) => {
        const nested = { ...item, x: Math.max(0, (Number(item.x) || 0) - minX), y: Math.max(0, (Number(item.y) || 0) - minY) };
        return nested;
      });
      return {
        type: "FRAME", name: band.name, x: minX, y: minY,
        width: Math.max(1, Math.min(frame.width, maxX - minX)),
        height: Math.max(1, Math.min(frame.height, maxY - minY)),
        noFill: true, clipsContent: false, children,
      };
    });
    normalized = groups;
  }

  // Hard cap the full hierarchy because every node is materialized as a native Figma object.
  function prune(nodes: Record<string, unknown>[], allowance: { count: number }, depth = 0): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    for (const node of nodes) {
      if (allowance.count >= 80 || depth > 4) break;
      allowance.count += 1;
      const copy = { ...node };
      if (Array.isArray(copy.children)) {
        copy.children = prune(copy.children as Record<string, unknown>[], allowance, depth + 1);
        if (!(copy.children as unknown[]).length) delete copy.children;
      }
      result.push(copy);
    }
    return result;
  }
  normalized = prune(normalized, { count: 0 });

  // Convert the semantic layer tree into a Figma-native layout contract before it
  // reaches the writer. Geometry remains available for intentional absolute overlays;
  // normal content flows through Auto Layout and uses modern HUG/FILL/FIXED sizing.
  function nodeRect(node: Record<string, unknown>) {
    return {
      x: Number(node.x) || 0, y: Number(node.y) || 0,
      width: Math.max(1, Number(node.width) || 1), height: Math.max(1, Number(node.height) || 1),
    };
  }
  function overlapRatio(a: Record<string, unknown>, b: Record<string, unknown>) {
    const ra = nodeRect(a), rb = nodeRect(b);
    const overlapW = Math.max(0, Math.min(ra.x + ra.width, rb.x + rb.width) - Math.max(ra.x, rb.x));
    const overlapH = Math.max(0, Math.min(ra.y + ra.height, rb.y + rb.height) - Math.max(ra.y, rb.y));
    return overlapW * overlapH / Math.max(1, Math.min(ra.width * ra.height, rb.width * rb.height));
  }
  function isBackdrop(child: Record<string, unknown>, parent: Record<string, unknown>) {
    const childBox = nodeRect(child), parentBox = nodeRect(parent);
    return ["RECTANGLE", "FRAME"].includes(String(child.type)) &&
      childBox.x <= 2 && childBox.y <= 2 &&
      childBox.width >= parentBox.width * 0.86 && childBox.height >= parentBox.height * 0.82;
  }
  function inferLayoutMode(parent: Record<string, unknown>, children: Record<string, unknown>[]) {
    const parentName = String(parent.name || "").toLowerCase();
    if (/progress|indicator|gauge|meter|ring|overlay|hero visual|decorative|avatar stack|icon stack/.test(parentName) ||
        children.some((child) => child.type === "ELLIPSE" && child.arcData && children.some((other) => other.type === "TEXT" && overlapRatio(child, other) > 0.22))) {
      return "NONE";
    }
    const flow = children.filter((child) => !isBackdrop(child, parent));
    if (flow.length <= 1) return "VERTICAL";
    let horizontalPairs = 0, verticalPairs = 0, comparablePairs = 0;
    for (let i = 0; i < flow.length; i += 1) {
      for (let j = i + 1; j < flow.length; j += 1) {
        const a = nodeRect(flow[i]), b = nodeRect(flow[j]);
        const centerAY = a.y + a.height / 2, centerBY = b.y + b.height / 2;
        const centerAX = a.x + a.width / 2, centerBX = b.x + b.width / 2;
        const overlap = overlapRatio(flow[i], flow[j]);
        if (overlap > 0.22) continue;
        comparablePairs += 1;
        if (Math.abs(centerAY - centerBY) <= Math.max(10, Math.min(a.height, b.height) * 0.45) &&
            Math.abs(centerAX - centerBX) > Math.max(8, Math.min(a.width, b.width) * 0.25)) horizontalPairs += 1;
        if (Math.abs(centerAX - centerBX) <= Math.max(12, Math.min(a.width, b.width) * 0.18) &&
            Math.abs(centerAY - centerBY) > Math.max(6, Math.min(a.height, b.height) * 0.35)) verticalPairs += 1;
      }
    }
    if (comparablePairs > 0 && horizontalPairs / comparablePairs >= 0.55) return "HORIZONTAL";
    if (comparablePairs > 0 && verticalPairs / comparablePairs >= 0.4) return "VERTICAL";
    // On content-heavy containers, a vertical stack is safer than fixed-position text
    // boxes competing for the same pixels. Known layered art/indicators stay absolute.
    if (/tabs|tab row|button group|actions row|metric row|summary row|value row|inline|toolbar|navigation/.test(parentName)) return "HORIZONTAL";
    return "VERTICAL";
  }
  function estimateGap(children: Record<string, unknown>[], mode: string) {
    const ordered = children.map(nodeRect).sort((a, b) => mode === "HORIZONTAL" ? a.x - b.x : a.y - b.y);
    const gaps: number[] = [];
    for (let i = 1; i < ordered.length; i += 1) {
      const gap = mode === "HORIZONTAL"
        ? ordered[i].x - (ordered[i - 1].x + ordered[i - 1].width)
        : ordered[i].y - (ordered[i - 1].y + ordered[i - 1].height);
      if (gap >= 0 && gap <= 64) gaps.push(gap);
    }
    if (!gaps.length) return 8;
    gaps.sort((a, b) => a - b);
    return Math.max(4, Math.min(24, Math.round(gaps[Math.floor(gaps.length / 2)])));
  }
  function applyLayoutContract(nodes: Record<string, unknown>[], parentMode: string = "NONE") {
    for (const node of nodes) {
      const children = Array.isArray(node.children) ? node.children as Record<string, unknown>[] : [];
      const type = String(node.type || "");
      if (type === "FRAME" && children.length) {
        const hasLayout = typeof node.layoutMode === "string";
        const layout = hasLayout
          ? String(node.layoutMode)
          : inferLayoutMode(node, children);
        node.layoutMode = layout;
        if (layout !== "NONE") {
          const name = String(node.name || "").toLowerCase();
          const isCard = /card|panel|summary|breakdown|loan|detail surface|content surface/.test(name);
          if (typeof node.itemSpacing !== "number") node.itemSpacing = estimateGap(children.filter((child) => !isBackdrop(child, node)), layout);
          if (typeof node.paddingLeft !== "number") node.paddingLeft = isCard ? 12 : 0;
          if (typeof node.paddingRight !== "number") node.paddingRight = isCard ? 12 : 0;
          if (typeof node.paddingTop !== "number") node.paddingTop = isCard ? 12 : 0;
          if (typeof node.paddingBottom !== "number") node.paddingBottom = isCard ? 12 : 0;
          if (typeof node.primaryAxisAlignItems !== "string") node.primaryAxisAlignItems = "MIN";
          if (typeof node.counterAxisAlignItems !== "string") node.counterAxisAlignItems = "MIN";
          if (typeof node.primaryAxisSizingMode !== "string") node.primaryAxisSizingMode = "FIXED";
          if (typeof node.counterAxisSizingMode !== "string") node.counterAxisSizingMode = "FIXED";

          for (const child of children) {
            if (isBackdrop(child, node)) {
              if (child.layoutPositioning === undefined) child.layoutPositioning = "ABSOLUTE";
              continue;
            }
          }
          // Preserve overlays (status badges, progress labels, arc indicators) as
          // native absolute children rather than letting Auto Layout push them away.
          for (let i = 0; i < children.length; i += 1) {
            const child = children[i];
            if (isBackdrop(child, node)) continue;
            const area = nodeRect(child).width * nodeRect(child).height;
            for (let j = 0; j < children.length; j += 1) {
              if (i === j || isBackdrop(children[j], node)) continue;
              const otherArea = nodeRect(children[j]).width * nodeRect(children[j]).height;
              const name = String(child.name || "").toLowerCase();
              const overlayLike = /badge|overlay|progress label|indicator label|icon|chevron|close|avatar|ring/.test(name);
              if (overlapRatio(child, children[j]) >= 0.24 && (area <= otherArea * 0.58 || overlayLike) &&
                  child.layoutPositioning === undefined) {
                child.layoutPositioning = "ABSOLUTE";
                break;
              }
            }
          }
          const backplates = children.filter((child) => isBackdrop(child, node));
          const flowChildren = children.filter((child) => !isBackdrop(child, node) && child.layoutPositioning !== "ABSOLUTE");
          const absoluteOverlays = children.filter((child) => !isBackdrop(child, node) && child.layoutPositioning === "ABSOLUTE");
          flowChildren.sort((a, b) => {
            const ra = nodeRect(a), rb = nodeRect(b);
            return layout === "HORIZONTAL" ? ra.x - rb.x : ra.y - rb.y;
          });
          children.splice(0, children.length, ...backplates, ...flowChildren, ...absoluteOverlays);
        } else {
          // A deliberately layered frame must keep its explicit coordinates.
          for (const child of children) {
            if (child.layoutPositioning === undefined) child.layoutPositioning = "ABSOLUTE";
          }
        }
      }

      // These are the modern child sizing properties, applied by the plugin only
      // after appendChild (Figma requires a real Auto Layout parent first).
      if (parentMode !== "NONE" && node.layoutPositioning !== "ABSOLUTE") {
        if (node.layoutSizingHorizontal === undefined) {
          node.layoutSizingHorizontal = type === "TEXT"
            ? (parentMode === "VERTICAL" ? "FILL" : "HUG")
            : (type === "FRAME" ? (parentMode === "VERTICAL" ? "FILL" : "HUG") : "FIXED");
        }
        if (node.layoutSizingVertical === undefined) {
          node.layoutSizingVertical = type === "TEXT" ? "HUG" : "FIXED";
        }
        if (type === "TEXT" && node.textAutoResize === undefined) {
          node.textAutoResize = parentMode === "VERTICAL" ? "HEIGHT" : "WIDTH_AND_HEIGHT";
        }
      }
      const nextParentMode = type === "FRAME" && typeof node.layoutMode === "string"
        ? String(node.layoutMode) : "NONE";
      applyLayoutContract(children, nextParentMode);
    }
  }
  // Top-level generated sections always flow vertically through a fixed viewport;
  // nested containers use inferred or model-declared native Auto Layout.
  applyLayoutContract(normalized, String(frame.layoutMode));
  if (frame.layoutMode !== "NONE" && normalized.length > 1) {
    normalized.sort((a, b) => {
      if (frame.layoutMode === "HORIZONTAL") return (Number(a.x) || 0) - (Number(b.x) || 0);
      return (Number(a.y) || 0) - (Number(b.y) || 0);
    });
  }
  return repairPlanGeometry({
    summary: String(root.summary ?? root.description ?? root.rationale ?? "A structured, high-fidelity native Figma design variation.").trim().slice(0, 700),
    frame,
    elements: normalized,
  });
}

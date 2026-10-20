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
  const frame = {
    name: String(rawFrame.name ?? rawFrame.title ?? root.frameName ?? "UX Direct Variation").trim().slice(0, 80) || "UX Direct Variation",
    width: Math.max(280, Math.min(1440, Math.round(Number.isFinite(frameWidth) ? frameWidth : 393))),
    height: Math.max(360, Math.min(4096, Math.round(Number.isFinite(frameHeight) ? frameHeight : 852))),
    backgroundColor: normalizeColor(rawFrame.backgroundColor ?? rawFrame.background ?? rawFrame.fill ?? rawFrame.color)
      || (Array.isArray(sourceNode.fillColors) && typeof sourceNode.fillColors[0] === "string" ? normalizeColor(sourceNode.fillColors[0]) : null)
      || "#F7F8FA",
  };
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
    if (strokeColor) normalized.strokeColor = strokeColor;
    if (typeof item.noFill === "boolean") normalized.noFill = item.noFill;
    const aliases: Array<[string, string]> = [
      ["strokeWeight", "strokeWeight"], ["opacity", "opacity"], ["cornerRadius", "cornerRadius"],
      ["clipsContent", "clipsContent"], ["layoutMode", "layoutMode"], ["itemSpacing", "itemSpacing"],
      ["paddingLeft", "paddingLeft"], ["paddingRight", "paddingRight"], ["paddingTop", "paddingTop"], ["paddingBottom", "paddingBottom"],
      ["primaryAxisAlignItems", "primaryAxisAlignItems"], ["counterAxisAlignItems", "counterAxisAlignItems"],
      ["primaryAxisSizingMode", "primaryAxisSizingMode"], ["counterAxisSizingMode", "counterAxisSizingMode"],
      ["textAlignHorizontal", "textAlignHorizontal"], ["textAlignVertical", "textAlignVertical"], ["textAutoResize", "textAutoResize"],
      ["textCase", "textCase"], ["textDecoration", "textDecoration"], ["shadowColor", "shadowColor"],
      ["shadowBlur", "shadowBlur"], ["shadowX", "shadowX"], ["shadowY", "shadowY"], ["shadowSpread", "shadowSpread"],
    ];
    for (const [sourceKey, targetKey] of aliases) {
      const rawValue = item[sourceKey] ?? (sourceKey === "cornerRadius" ? item.radius ?? item.borderRadius : undefined);
      if (rawValue === undefined) continue;
      if (sourceKey === "shadowColor") {
        const normalizedColor = normalizeColor(rawValue);
        if (normalizedColor) normalized[targetKey] = normalizedColor;
      } else if (sourceKey === "clipsContent" && typeof rawValue === "boolean") normalized[targetKey] = rawValue;
      else if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
        const ranges: Record<string, [number, number]> = {
          strokeWeight: [0, 20], opacity: [0, 1], cornerRadius: [0, 128],
          itemSpacing: [0, 160], paddingLeft: [0, 160], paddingRight: [0, 160],
          paddingTop: [0, 160], paddingBottom: [0, 160], shadowBlur: [0, 80],
          shadowX: [-30, 30], shadowY: [-30, 30], shadowSpread: [-30, 30],
        };
        const range = ranges[targetKey];
        normalized[targetKey] = range ? Math.max(range[0], Math.min(range[1], rawValue)) : rawValue;
      } else if (typeof rawValue === "string") {
        const enumKeys = new Set([
          "layoutMode", "primaryAxisAlignItems", "counterAxisAlignItems", "primaryAxisSizingMode",
          "counterAxisSizingMode", "textAlignHorizontal", "textAlignVertical", "textAutoResize", "textCase", "textDecoration",
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
  const countTree = (nodes: Record<string, unknown>[]): number => nodes.reduce((count, node) =>
    count + 1 + (Array.isArray(node.children) ? countTree(node.children as Record<string, unknown>[]) : 0), 0);
  const namedFrameGroups = normalized.filter((node) => node.type === "FRAME" && Array.isArray(node.children) && node.children.length > 0).length;
  const alreadyStructured = normalized.length >= 5 && normalized.length <= 12 &&
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
    const bands = [
      { name: "Header & navigation", start: 0, end: 0.14 },
      { name: "Status & section tabs", start: 0.14, end: 0.30 },
      { name: "Primary information", start: 0.30, end: 0.55 },
      { name: "Details & breakdown", start: 0.55, end: 0.78 },
      { name: "Actions & support", start: 0.78, end: 1.5 },
    ];
    const groups = bands.map((band, index) => {
      const bucket = allLeaves.filter((item) => {
        const x = Number(item.x) || 0;
        const y = Number(item.y) || 0;
        const h = Number(item.height) || 0;
        const w = Number(item.width) || 0;
        const centerY = y + h / 2;
        if (item.type === "RECTANGLE" && x <= 2 && y <= 2 && w >= frame.width * 0.94 && h >= frame.height * 0.9) return false;
        return centerY / frame.height >= band.start && centerY / frame.height < band.end;
      }).slice(0, 30);
      if (!bucket.length && allLeaves.length) {
        const sorted = allLeaves.slice().sort((a, b) => (Number(a.y) || 0) - (Number(b.y) || 0));
        const fallback = sorted[Math.min(sorted.length - 1, Math.floor(index * sorted.length / bands.length))];
        if (fallback && !bands.slice(0, index).some((earlier) => earlier.name === (fallback as Record<string, unknown>).__fallbackGroup)) {
          bucket.push(fallback);
          (fallback as Record<string, unknown>).__fallbackGroup = band.name;
        }
      }
      const minX = bucket.length ? Math.max(0, Math.min(...bucket.map((item) => Number(item.x) || 0))) : 16;
      const minY = bucket.length ? Math.max(0, Math.min(...bucket.map((item) => Number(item.y) || 0))) : Math.round(frame.height * band.start);
      const maxX = bucket.length ? Math.max(...bucket.map((item) => (Number(item.x) || 0) + (Number(item.width) || 1)) : frame.width - 16;
      const maxY = bucket.length ? Math.max(...bucket.map((item) => (Number(item.y) || 0) + (Number(item.height) || 1)) : minY + 1;
      const children = bucket.map((item) => {
        const nested = { ...item, x: Math.max(0, (Number(item.x) || 0) - minX), y: Math.max(0, (Number(item.y) || 0) - minY) };
        delete nested.__fallbackGroup;
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
  return {
    summary: String(root.summary ?? root.description ?? root.rationale ?? "A structured, high-fidelity native Figma design variation.").trim().slice(0, 700),
    frame,
    elements: normalized,
  };
}

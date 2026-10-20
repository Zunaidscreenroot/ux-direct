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
    backgroundColor: normalizeColor(rawFrame.backgroundColor ?? rawFrame.background ?? rawFrame.fill ?? rawFrame.color) || "#F7F8FA",
  };
  const inputElements = root.elements ?? root.layers ?? root.nodes ?? root.children;
  if (!Array.isArray(inputElements)) {
    return { summary: root.summary ?? root.description ?? "A UX Direct native design variation.", frame, elements: inputElements };
  }

  const flattened: Array<{ item: Record<string, unknown>; offsetX: number; offsetY: number }> = [];
  function flatten(items: unknown[], offsetX = 0, offsetY = 0, depth = 0) {
    if (depth > 4 || flattened.length >= 80) return;
    for (const raw of items) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      const x = typeof item.x === "number" && Number.isFinite(item.x) ? item.x : 0;
      const y = typeof item.y === "number" && Number.isFinite(item.y) ? item.y : 0;
      flattened.push({ item, offsetX, offsetY });
      if (Array.isArray(item.children) && depth < 4) flatten(item.children, offsetX + x, offsetY + y, depth + 1);
      if (flattened.length >= 80) break;
    }
  }
  flatten(inputElements);
  const elements = flattened.map(({ item, offsetX, offsetY }, index) => {
    const type = normalizeElementType(item.type ?? item.kind ?? item.elementType ?? item.nodeType, item);
    const textValue = item.text ?? item.content ?? item.characters ?? item.value;
    const text = typeof textValue === "string" ? textValue.slice(0, 1800) : undefined;
    const fallbackName = text ? "Text · " + text.replace(/\s+/g, " ").slice(0, 42) : type.charAt(0) + type.slice(1).toLowerCase() + " " + (index + 1);
    const nameValue = item.name ?? item.layerName ?? item.label ?? item.title ?? item.id;
    const name = (typeof nameValue === "string" && nameValue.trim() ? nameValue.trim() : fallbackName).slice(0, 80);
    const explicitX = item.x ?? item.left;
    const explicitY = item.y ?? item.top;
    const gridX = 20 + (index % 3) * 8;
    const gridY = 20 + Math.floor(index / 3) * 48;
    const x = Math.max(-1000, Math.min(5000, offsetX + (typeof explicitX === "number" && Number.isFinite(explicitX) ? explicitX : gridX)));
    const y = Math.max(-1000, Math.min(5000, offsetY + (typeof explicitY === "number" && Number.isFinite(explicitY) ? explicitY : gridY)));
    const widthValue = item.width ?? item.w;
    const heightValue = item.height ?? item.h;
    const width = typeof widthValue === "number" && Number.isFinite(widthValue) ? widthValue : (type === "TEXT" ? 280 : 160);
    const height = typeof heightValue === "number" && Number.isFinite(heightValue) ? heightValue : (type === "TEXT" ? 34 : 60);
    const color = normalizeColor(item.color ?? item.fill ?? item.backgroundColor ?? item.background ?? item.fillColor);
    const strokeColor = normalizeColor(item.strokeColor ?? item.stroke ?? item.borderColor);
    const fontRaw = item.font && typeof item.font === "object" && !Array.isArray(item.font) ? item.font as Record<string, unknown> : {};
    const normalized: Record<string, unknown> = {
      type, name, x, y,
      width: Math.max(1, Math.min(4096, width)),
      height: Math.max(1, Math.min(4096, height)),
    };
    if (text !== undefined && type === "TEXT") normalized.text = text;
    if (typeof item.fontSize === "number" || typeof item.textSize === "number") normalized.fontSize = item.fontSize ?? item.textSize;
    if (typeof item.fontFamily === "string" || typeof fontRaw.family === "string") normalized.fontFamily = item.fontFamily ?? fontRaw.family;
    if (typeof item.fontStyle === "string" || typeof fontRaw.style === "string" || typeof fontRaw.weight === "string") normalized.fontStyle = item.fontStyle ?? fontRaw.style ?? fontRaw.weight;
    if (color) normalized.color = color;
    if (strokeColor) normalized.strokeColor = strokeColor;
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
      const raw = item[sourceKey] ?? (sourceKey === "cornerRadius" ? item.radius ?? item.borderRadius : undefined);
      if (raw === undefined) continue;
      if (sourceKey === "shadowColor") {
        const normalizedColor = normalizeColor(raw);
        if (normalizedColor) normalized[targetKey] = normalizedColor;
      } else if (sourceKey === "clipsContent" && typeof raw === "boolean") normalized[targetKey] = raw;
      else if (typeof raw === "number" && Number.isFinite(raw)) {
        const ranges: Record<string, [number, number]> = {
          strokeWeight: [0, 20], opacity: [0, 1], cornerRadius: [0, 128],
          itemSpacing: [0, 160], paddingLeft: [0, 160], paddingRight: [0, 160],
          paddingTop: [0, 160], paddingBottom: [0, 160], shadowBlur: [0, 80],
          shadowX: [-30, 30], shadowY: [-30, 30], shadowSpread: [-30, 30],
        };
        const range = ranges[targetKey];
        normalized[targetKey] = range ? Math.max(range[0], Math.min(range[1], raw)) : raw;
      } else if (typeof raw === "string") {
        const enumKeys = new Set([
          "layoutMode", "primaryAxisAlignItems", "counterAxisAlignItems", "primaryAxisSizingMode",
          "counterAxisSizingMode", "textAlignHorizontal", "textAlignVertical", "textAutoResize",
          "textCase", "textDecoration",
        ]);
        let enumValue = raw.trim().toUpperCase().replace(/[ -]+/g, "_");
        if (targetKey === "textCase") {
          if (enumValue === "UPPERCASE" || enumValue === "UPPER_CASE") enumValue = "UPPER";
          if (enumValue === "LOWERCASE" || enumValue === "LOWER_CASE") enumValue = "LOWER";
          if (enumValue === "TITLE_CASE") enumValue = "TITLE";
        }
        if (enumKeys.has(targetKey)) normalized[targetKey] = enumValue;
        else normalized[targetKey] = raw.trim().slice(0, 100);
      }
    }
    return normalized;
  });
  return {
    summary: String(root.summary ?? root.description ?? root.rationale ?? "A polished native Figma design variation.").trim().slice(0, 700),
    frame,
    elements,
  };
}


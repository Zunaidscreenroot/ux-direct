import { providerFetch } from "@/src/providers/provider-fetch";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NATIVE_INSTANCE_ELEMENT_FIELDS } from "@/src/figma-agent/native-action-schema";
import { detectDomain, detectTaskRole, roleInstructions } from "@/src/figma-agent/agent-roles";
import { runSubAgents, subAgentsEnabled, type AgentBrief } from "@/src/figma-agent/sub-agents";
import { designerPersona, gatewaySeat, inventedTexts, isValueText, leadApproves, sourceContentTexts, leadMaxRounds, leadReview, lostTexts, missingFromSpec, sourceControls, reviseFromNotes, seatKnowledge, studioReviewEnabled, taskOwner } from "@/src/figma-agent/studio";
import { agencyEnabled, agencyHandlesRole, runAgency, truncatedContentNames, type AgencyResult } from "@/src/figma-agent/agency";
import { buildBrainSystemPrompt, resolveBrainScopes, type BrainContextPromptInput } from "@/src/memory/chat-context";
import { retrieveBrainContext } from "@/src/memory/shared-brain";
import { buildBrainQuery } from "@/src/memory/brain-query";
import { resolveFigmaTaskProject, resolveFigmaTaskScope } from "@/src/memory/task-learning";
import { sanitizeInlineLearningCandidate } from "@/src/memory/inline-learning";
import { deferTaskWork, finishTaskRun, startTaskRun, type RetrievalRecord } from "@/src/memory/task-run-log";
import { FIGMA_AGENT_MODELS, UX_DIRECT_DESIGN_ROLE } from "@/src/providers/openrouter-models";
import { getResolvedActiveChatProvider } from "@/src/providers/runtime-chat-provider";
import { figmaModelChain, FREELLMAPI_FIRST_ATTEMPT_TIMEOUT_MS, FREELLMAPI_RECOVERY_TIMEOUT_MS, routedVia, shouldRetryWithoutJsonMode, figmaMaxTokens, figmaRoutingHeaders, RENDERED_IMAGE_MAX_CHARS } from "@/src/providers/active-chat-provider";
import { normalizePlan } from "@/src/figma-agent/normalize-plan";
import { auditDesignPlanQuality, missingSourceTexts } from "@/src/figma-agent/design-plan-quality";
import { designRulesBlock } from "@/src/figma-agent/design-rules";
import { canvasTexts, contentLocaleInstruction, inferContentLocale } from "@/src/figma-agent/content-locale";
import { CREATE_DESIGN_SCOPE, CREATE_OPERATING_CONTRACT, createFrameSize, createModeCanvas, createScopeInstructions } from "@/src/figma-agent/create-mode";
import { SCREEN_STATES, STATE_BRIEFS, stateDropsContent, stateFallbackSpec, stateGatePrompt } from "@/src/figma-agent/screen-states";
import { appendMissingSourceText, applyVariationDirection, MAX_REPAIRED_TEXTS, promptRequestsWireframe, stabilizeBlockSpec } from "@/src/figma-agent/spec-consistency";
import { loadVerifiedExample, recordGeneration, type GenerationRecord } from "@/src/memory/verified-specs";
import { describeModelContent, extractPlanJson } from "@/src/figma-agent/extract-plan-json";
import { BLOCK_SPEC_CONTRACT, BLOCK_SPEC_EXAMPLE, PLAN_NODE_LIMIT, expandBlockSpec, isBlockSpec, sourceFallbackSpec } from "@/src/figma-agent/block-spec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Longest the planner waits for the sub-agent brief before planning without it. */
const PLANNER_AGENT_WAIT_MS = 6000;
// Approved memory_type values with design value (brain monitor, 2026-11-07). design_decision is left
// out: its only row is a client-scope note.
const FIGMA_MEMORY_TYPES = ["approved_pattern", "failure_pattern", "coaching_rule", "quality_heuristic", "domain_principle"];
const BRAIN_WAIT_MS = 5000;
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out after " + ms + "ms")), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
const API_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);
function allowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin || API_ORIGINS.has(origin);
}
function cors(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  const ok = origin && (origin === new URL(request.url).origin || API_ORIGINS.has(origin));
  return {
    ...(ok ? { "Access-Control-Allow-Origin": origin! } : {}),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

const ElementFieldsSchema = z.object({
  type: z.enum(["RECTANGLE", "ELLIPSE", "TEXT", "LINE", "FRAME", "POLYGON", "STAR", "INSTANCE", "CLONE"]),
  name: z.string().trim().min(1).max(80),
  /** CLONE only: the source layer (logo, icon, chart, image) copied into the variation. */
  sourceNodeId: z.string().trim().min(1).max(100).optional(),
  /** CLONE only: recolour the copy to one ink colour (wireframes); images become placeholder boxes. */
  monochrome: z.object({ ink: z.string().regex(/^#[0-9A-Fa-f]{6}$/), placeholder: z.string().regex(/^#[0-9A-Fa-f]{6}$/) }).strict().optional(),
  ...NATIVE_INSTANCE_ELEMENT_FIELDS,
  x: z.number().finite().min(-1000).max(5000),
  y: z.number().finite().min(-1000).max(5000),
  width: z.number().finite().min(1).max(4096),
  height: z.number().finite().min(1).max(4096),
  text: z.string().max(1800).optional(),
  fontSize: z.number().finite().min(8).max(96).optional(),
  fontFamily: z.string().trim().min(1).max(100).optional(),
  fontStyle: z.string().trim().min(1).max(100).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  paintStyleId: z.string().trim().min(1).max(300).optional(),
  strokeStyleId: z.string().trim().min(1).max(300).optional(),
  textStyleId: z.string().trim().min(1).max(300).optional(),
  textOverrides: z.record(z.string().max(120), z.string().max(500)).optional(),
  effectStyleId: z.string().trim().min(1).max(300).optional(),
  gridStyleId: z.string().trim().min(1).max(300).optional(),
  noFill: z.boolean().optional(),
  strokeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  strokeWeight: z.number().finite().min(0).max(20).optional(),
  arcData: z.object({
    startingAngle: z.number().finite().min(-6.283185307179586).max(6.283185307179586),
    endingAngle: z.number().finite().min(-6.283185307179586).max(6.283185307179586),
    innerRadius: z.number().finite().min(0).max(1),
  }).strict().optional(),
  opacity: z.number().finite().min(0).max(1).optional(),
  cornerRadius: z.number().finite().min(0).max(128).optional(),
  clipsContent: z.boolean().optional(),
  layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional(),
  layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional(),
  layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional(),
  layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional(),
  layoutPositioning: z.enum(["AUTO", "ABSOLUTE"]).optional(),
  layoutGrow: z.number().finite().min(0).max(1).optional(),
  horizontalConstraint: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]).optional(),
  verticalConstraint: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]).optional(),
  itemSpacing: z.number().finite().min(0).max(160).optional(),
  paddingLeft: z.number().finite().min(0).max(160).optional(),
  paddingRight: z.number().finite().min(0).max(160).optional(),
  paddingTop: z.number().finite().min(0).max(160).optional(),
  paddingBottom: z.number().finite().min(0).max(160).optional(),
  primaryAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]).optional(),
  counterAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional(),
  primaryAxisSizingMode: z.enum(["AUTO", "FIXED"]).optional(),
  counterAxisSizingMode: z.enum(["AUTO", "FIXED"]).optional(),
  textAlignHorizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
  textAlignVertical: z.enum(["TOP", "CENTER", "BOTTOM"]).optional(),
  textAutoResize: z.enum(["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"]).optional(),
  lineHeight: z.object({ unit: z.enum(["PIXELS", "PERCENT"]), value: z.number().finite().min(1).max(500) }).strict().optional(),
  letterSpacing: z.object({ unit: z.enum(["PIXELS", "PERCENT"]), value: z.number().finite().min(-100).max(500) }).strict().optional(),
  textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional(),
  textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
  shadowColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  shadowBlur: z.number().finite().min(0).max(80).optional(),
  shadowX: z.number().finite().min(-30).max(30).optional(),
  shadowY: z.number().finite().min(-30).max(30).optional(),
  shadowSpread: z.number().finite().min(-30).max(30).optional(),
});
const ElementSchema: z.ZodTypeAny = z.lazy(() =>
  ElementFieldsSchema.extend({ children: z.array(ElementSchema).max(80).optional() })
    .strict()
    .superRefine((item, ctx) => {
      if (item.type === "TEXT" && typeof item.text !== "string") {
        ctx.addIssue({ code: "custom", path: ["text"], message: "TEXT elements require text." });
      }
      if (item.type === "INSTANCE" && !item.componentId) {
        ctx.addIssue({ code: "custom", path: ["componentId"], message: "INSTANCE elements require componentId from the component catalogue." });
      }
      if (item.type !== "INSTANCE" && (item.componentId !== undefined || item.instanceProperties !== undefined || item.textOverrides !== undefined)) {
        ctx.addIssue({ code: "custom", path: ["componentId"], message: "componentId/instanceProperties are only valid on INSTANCE elements." });
      }
      if ((item.type === "CLONE") !== (typeof item.sourceNodeId === "string")) {
        ctx.addIssue({ code: "custom", path: ["sourceNodeId"], message: "sourceNodeId is required on CLONE elements and only valid there." });
      }
      if (Array.isArray(item.children) && item.children.length && item.type !== "FRAME") {
        ctx.addIssue({ code: "custom", path: ["children"], message: "Only FRAME elements may contain nested children." });
      }
      if (item.noFill === true && item.type !== "FRAME") {
        ctx.addIssue({ code: "custom", path: ["noFill"], message: "noFill is supported only for FRAME containers." });
      }
      if (item.arcData !== undefined && item.type !== "ELLIPSE") {
        ctx.addIssue({ code: "custom", path: ["arcData"], message: "arcData is supported only on ELLIPSE nodes." });
      }
      if (item.arcData && item.arcData.endingAngle <= item.arcData.startingAngle) {
        ctx.addIssue({ code: "custom", path: ["arcData", "endingAngle"], message: "endingAngle must be greater than startingAngle." });
      }
      if (item.layoutMode !== undefined && item.type !== "FRAME") {
        ctx.addIssue({ code: "custom", path: ["layoutMode"], message: "Auto Layout container properties belong on FRAME elements." });
      }
      if (item.layoutWrap !== undefined && item.layoutMode !== "HORIZONTAL") {
        ctx.addIssue({ code: "custom", path: ["layoutWrap"], message: "Wrap is supported only on horizontal Auto Layout frames." });
      }
      if ((item.horizontalConstraint !== undefined || item.verticalConstraint !== undefined) && item.layoutPositioning !== "ABSOLUTE") {
        ctx.addIssue({ code: "custom", path: ["layoutPositioning"], message: "Responsive constraints are for intentionally positioned children; set layoutPositioning to ABSOLUTE." });
      }
    })
);
const PlanObjectSchema = z.object({
  summary: z.string().trim().min(8).max(700),
  frame: z.object({
    name: z.string().trim().min(1).max(80),
    width: z.number().int().min(280).max(1440),
    height: z.number().int().min(360).max(4096),
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]),
    itemSpacing: z.number().finite().min(0).max(160),
    paddingLeft: z.number().finite().min(0).max(160),
    paddingRight: z.number().finite().min(0).max(160),
    paddingTop: z.number().finite().min(0).max(160),
    paddingBottom: z.number().finite().min(0).max(160),
    primaryAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]),
    counterAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "BASELINE"]),
    primaryAxisSizingMode: z.enum(["AUTO", "FIXED"]),
    counterAxisSizingMode: z.enum(["AUTO", "FIXED"]),
  }).strict(),
  elements: z.array(ElementSchema).min(1).max(8),
}).strict();
/**
 * rich: the richness floor (3+ sections, 18+ nodes, 6+ texts) for model-authored layer trees.
 * Block-rendered plans get their structure from code and their content check from the quality
 * audit, so a small source screen must not be rejected for being small.
 */
function checkPlanShape(plan: z.infer<typeof PlanObjectSchema>, ctx: z.RefinementCtx, rich: boolean) {
  let totalNodes = 0;
  let namedContainers = 0;
  let invalidChildType = false;
  const count = (nodes: unknown[]) => {
    for (const value of nodes) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const node = value as Record<string, unknown>;
      totalNodes += 1;
      const children = Array.isArray(node.children) ? node.children : [];
      if (node.type === "FRAME" && children.length > 0) namedContainers += 1;
      if (children.length > 0 && node.type !== "FRAME") invalidChildType = true;
      count(children);
    }
  };
  count(plan.elements as unknown[]);
  if (rich && plan.elements.length < 3) {
    ctx.addIssue({ code: "custom", path: ["elements"], message: "Use 3–8 top-level FRAME sections." });
  }
  if (plan.elements.some((element) => (element as Record<string, unknown>).type !== "FRAME")) {
    ctx.addIssue({ code: "custom", path: ["elements"], message: "Top-level design sections must be named FRAME containers." });
  }
  if (rich && namedContainers < 4) {
    ctx.addIssue({ code: "custom", path: ["elements"], message: "Use at least four meaningful FRAME containers with nested native layers." });
  }
  if (rich && totalNodes < 18) {
    ctx.addIssue({ code: "custom", path: ["elements"], message: "Design hierarchy is too sparse; include enough native components and content layers." });
  }
  const textNodes: Record<string, unknown>[] = [];
  const repeatedText = new Map<string, number>();
  const visitQuality = (nodes: unknown[]) => {
    for (const value of nodes) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const node = value as Record<string, unknown>;
      if (node.type === "TEXT") {
        const text = typeof node.text === "string" ? node.text.trim() : "";
        textNodes.push(node);
        if (text) repeatedText.set(text.toLowerCase(), (repeatedText.get(text.toLowerCase()) || 0) + 1);
      }
      // Text overrides on design-system instances are real content, not decoration.
      if (node.type === "INSTANCE" && node.instanceProperties && typeof node.instanceProperties === "object") {
        for (const value of Object.values(node.instanceProperties as Record<string, unknown>)) {
          if (typeof value === "string" && value.trim() && !/^(true|false)$/i.test(value.trim())) textNodes.push({ type: "TEXT", text: value });
        }
      }
      if (node.type === "INSTANCE" && node.textOverrides && typeof node.textOverrides === "object") {
        for (const value of Object.values(node.textOverrides as Record<string, unknown>)) {
          if (typeof value === "string" && value.trim()) textNodes.push({ type: "TEXT", text: value });
        }
      }
      visitQuality(Array.isArray(node.children) ? node.children : []);
    }
  };
  visitQuality(plan.elements as unknown[]);
  const meaningfulText = textNodes.filter(node => typeof node.text === "string" &&
    String(node.text).trim().length >= 2 &&
    !/^(rectangle|frame|text|ellipse|line|container|section|placeholder|sample text)$/i.test(String(node.text).trim()));
  if (rich ? textNodes.length < 6 || meaningfulText.length < 5 : meaningfulText.length < 1) {
    ctx.addIssue({ code: "custom", path: ["elements"], message: "Design needs more meaningful native text content; placeholders or mostly decorative shapes are not sufficient." });
  }
  const decorativeDominance = rich && totalNodes > 0 && textNodes.length / totalNodes < 0.22;
  if (decorativeDominance) {
    ctx.addIssue({ code: "custom", path: ["elements"], message: "Design is too shape-heavy relative to its meaningful content. Add labels, values, and task-specific detail." });
  }
  if (totalNodes > PLAN_NODE_LIMIT) {
    ctx.addIssue({ code: "custom", path: ["elements"], message: "Design exceeds the safe " + PLAN_NODE_LIMIT + "-node budget." });
  }
  if (invalidChildType) {
    ctx.addIssue({ code: "custom", path: ["elements"], message: "Nested children must belong to FRAME containers." });
  }
}
const PlanSchema = PlanObjectSchema.superRefine((plan, ctx) => checkPlanShape(plan, ctx, true));
const BlockPlanSchema = PlanObjectSchema.superRefine((plan, ctx) => checkPlanShape(plan, ctx, false));

type CanvasNode = {
  id?: string; name?: string; type?: string; x?: number; y?: number;
  width?: number; height?: number; text?: string; fontSize?: number;
  fillColors?: string[]; visible?: boolean; layoutMode?: string; layoutWrap?: string;
  layoutSizingHorizontal?: string; layoutSizingVertical?: string; layoutPositioning?: string;
  primaryAxisSizingMode?: string; counterAxisSizingMode?: string; itemSpacing?: number;
  paddingLeft?: number; paddingRight?: number; paddingTop?: number; paddingBottom?: number;
  primaryAxisAlignItems?: string; counterAxisAlignItems?: string; textAutoResize?: string;
  horizontalConstraint?: string; verticalConstraint?: string;
  componentProperties?: Record<string, string | boolean>;
  childCount?: number; children?: CanvasNode[];
};
/** Model-facing canvas budget: deep enough for card internals (rows, badges, icons) of a full screen. */
const COMPACT_NODE_LIMIT = 400;
const COMPACT_DEPTH_LIMIT = 8;
function compactNode(value: unknown, state: { count: number }, depth = 0): CanvasNode | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || state.count >= COMPACT_NODE_LIMIT) return null;
  const node = value as Record<string, unknown>;
  if (typeof node.name !== "string" || typeof node.type !== "string") return null;
  state.count += 1;
  const out: CanvasNode = { name: node.name.slice(0, 120), type: node.type.slice(0, 40) };
  for (const key of [
    "id", "x", "y", "width", "height", "text", "fontSize", "visible", "layoutMode", "layoutWrap",
    "layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning", "primaryAxisSizingMode",
    "counterAxisSizingMode", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
    "primaryAxisAlignItems", "counterAxisAlignItems", "textAutoResize", "horizontalConstraint", "verticalConstraint",
    "childCount", "fontStyle", "textStyleId", "mainComponentId",
  ] as const) {
    const valueAtKey = node[key];
    if (key === "id" && typeof valueAtKey === "string") out.id = valueAtKey.slice(0, 100);
    if (["x", "y", "width", "height", "fontSize", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "childCount"].includes(key) && typeof valueAtKey === "number" && Number.isFinite(valueAtKey)) (out as unknown as Record<string, unknown>)[key] = valueAtKey;
    if (key === "text" && typeof valueAtKey === "string") out.text = valueAtKey.slice(0, 350);
    if (key === "visible" && typeof valueAtKey === "boolean") out.visible = valueAtKey;
    if (["fontStyle", "textStyleId", "mainComponentId"].includes(key) && typeof valueAtKey === "string" && valueAtKey) (out as unknown as Record<string, unknown>)[key] = valueAtKey.slice(0, 300);
    if (["layoutMode", "layoutWrap", "layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning", "primaryAxisSizingMode", "counterAxisSizingMode", "primaryAxisAlignItems", "counterAxisAlignItems", "textAutoResize", "horizontalConstraint", "verticalConstraint"].includes(key) && typeof valueAtKey === "string") (out as unknown as Record<string, unknown>)[key] = valueAtKey.slice(0, 20);
  }
  if (Array.isArray(node.fillColors)) out.fillColors = node.fillColors.filter((color): color is string => typeof color === "string").slice(0, 4);
  if (node.componentProperties && typeof node.componentProperties === "object" && !Array.isArray(node.componentProperties)) {
    out.componentProperties = Object.fromEntries(Object.entries(node.componentProperties as Record<string, unknown>).slice(0, 16)
      .filter((entry): entry is [string, string | boolean] => typeof entry[1] === "string" || typeof entry[1] === "boolean")
      .map(([key, entryValue]) => [key.slice(0, 80), typeof entryValue === "string" ? entryValue.slice(0, 120) : entryValue]));
  }
  if (depth < COMPACT_DEPTH_LIMIT && Array.isArray(node.children)) {
    out.children = [];
    for (const child of node.children.slice(0, 50)) {
      const compact = compactNode(child, state, depth + 1);
      if (compact) out.children.push(compact);
      if (state.count >= COMPACT_NODE_LIMIT) break;
    }
  }
  return out;
}
function compactRecoveryNode(
  value: unknown,
  state: { count: number },
  depth = 0,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 4 || state.count >= 60) return null;
  const source = value as Record<string, unknown>;
  if (typeof source.type !== "string") return null;
  state.count += 1;
  const out: Record<string, unknown> = { type: source.type };
  for (const key of [
    "id", "name", "text", "x", "y", "width", "height", "fontSize", "layoutMode", "layoutWrap",
    "layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning", "primaryAxisSizingMode",
    "counterAxisSizingMode", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
    "primaryAxisAlignItems", "counterAxisAlignItems", "textAutoResize", "horizontalConstraint", "verticalConstraint",
    "childCount",
  ] as const) {
    const raw = source[key];
    if (typeof raw === "string") out[key] = raw.slice(0, key === "text" ? 140 : 80);
    else if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
  }
  if (Array.isArray(source.fillColors)) out.fillColors = source.fillColors.filter((item): item is string => typeof item === "string").slice(0, 2);
  if (Array.isArray(source.children) && depth < 4) {
    const children: Record<string, unknown>[] = [];
    for (const child of source.children.slice(0, 10)) {
      const nested = compactRecoveryNode(child, state, depth + 1);
      if (nested) children.push(nested);
      if (state.count >= 60) break;
    }
    if (children.length) out.children = children;
  }
  return out;
}

function compactRecoveryCanvas(canvas: Record<string, unknown>): Record<string, unknown> {
  const state = { count: 0 };
  const sourceNodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
  const nodes = sourceNodes.slice(0, 8)
    .map((node) => compactRecoveryNode(node, state))
    .filter((node): node is Record<string, unknown> => !!node);
  return {
    pageName: typeof canvas.pageName === "string" ? canvas.pageName.slice(0, 80) : "",
    scope: typeof canvas.scope === "string" ? canvas.scope.slice(0, 30) : "selection",
    nodes,
  };
}


function collectSourceTextInventory(nodes: unknown[]): Array<{ name: string; text: string }> {
  const result: Array<{ name: string; text: string }> = [];
  const visit = (items: unknown[], depth = 0) => {
    if (depth > 12 || result.length >= 80) return;
    for (const value of items) {
      if (!value || typeof value !== "object" || Array.isArray(value) || result.length >= 80) continue;
      const node = value as Record<string, unknown>;
      if (node.visible === false || node.opacity === 0) continue;
      if (node.type === "TEXT" && typeof node.text === "string" && node.text.trim()) {
        result.push({
          name: typeof node.name === "string" ? node.name.slice(0, 100) : "Text layer",
          text: node.text.slice(0, 240),
        });
      }
      if (Array.isArray(node.children)) visit(node.children, depth + 1);
    }
  };
  visit(nodes);
  return result;
}

function compactResourceList(value: unknown, limit = 50): Array<Record<string, string | number>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.name !== "string") return [];
    return [{ id: item.id.slice(0, 300), name: item.name.slice(0, 120),
      ...(typeof item.type === "string" ? { type: item.type.slice(0, 40) } : {}),
      ...(typeof item.collectionName === "string" ? { collectionName: item.collectionName.slice(0, 100) } : {}),
      ...(typeof item.collectionId === "string" ? { collectionId: item.collectionId.slice(0, 300) } : {}),
      // Style metrics used to bind generated layers to the file's own text/paint styles.
      ...(typeof item.color === "string" && /^#[0-9A-Fa-f]{6}$/.test(item.color) ? { color: item.color.toUpperCase() } : {}),
      ...(typeof item.fontSize === "number" && Number.isFinite(item.fontSize) ? { fontSize: item.fontSize } : {}),
      ...(typeof item.fontFamily === "string" ? { fontFamily: item.fontFamily.slice(0, 100) } : {}),
      ...(typeof item.fontStyle === "string" ? { fontStyle: item.fontStyle.slice(0, 100) } : {}) }];
  });
}
function compactCanvas(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { pageName: "Unknown page", nodes: [] };
  const canvas = value as Record<string, unknown>;
  const state = { count: 0 };
  const nodes = Array.isArray(canvas.nodes)
    ? canvas.nodes.slice(0, 20).map((node) => compactNode(node, state)).filter((node): node is CanvasNode => !!node)
    : [];
  const rawStyles = canvas.styles && typeof canvas.styles === "object" && !Array.isArray(canvas.styles) ? canvas.styles as Record<string, unknown> : {};
  const styles = { paint: compactResourceList(rawStyles.paint, 100), text: compactResourceList(rawStyles.text, 100),
    effect: compactResourceList(rawStyles.effect), grid: compactResourceList(rawStyles.grid) };
  const variableCollections = Array.isArray(canvas.variableCollections) ? canvas.variableCollections.slice(0, 30).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.name !== "string") return [];
    return [{ id: item.id.slice(0, 300), name: item.name.slice(0, 100),
      modes: Array.isArray(item.modes) ? item.modes.slice(0, 8).flatMap((mode) => {
        if (!mode || typeof mode !== "object" || Array.isArray(mode)) return [];
        const data = mode as Record<string, unknown>;
        return typeof data.modeId === "string" && typeof data.name === "string"
          ? [{ modeId: data.modeId.slice(0, 100), name: data.name.slice(0, 100) }] : [];
      }) : [] }];
  }) : [];
  return { pageName: typeof canvas.pageName === "string" ? canvas.pageName.slice(0, 120) : "Unknown page",
    scope: typeof canvas.scope === "string" ? canvas.scope.slice(0, 40) : "selection",
    nodeCount: state.count, truncated: canvas.truncated === true || state.count >= COMPACT_NODE_LIMIT, nodes,
    viewport: canvas.viewport && typeof canvas.viewport === "object" ? canvas.viewport : undefined,
    styles, variableCollections, variables: compactResourceList(canvas.variables, 120),
    components: compactComponentCatalogue(canvas.components) };
}

/** Bounded design-system catalogue so plans can place real component instances. */
function compactComponentCatalogue(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.name !== "string") return [];
    const rawProps = item.properties && typeof item.properties === "object" && !Array.isArray(item.properties)
      ? item.properties as Record<string, unknown> : {};
    const properties = Object.fromEntries(Object.entries(rawProps).slice(0, 16).flatMap(([key, def]) => {
      if (!def || typeof def !== "object" || Array.isArray(def)) return [];
      const data = def as Record<string, unknown>;
      if (typeof data.type !== "string") return [];
      return [[key.slice(0, 80), {
        type: data.type.slice(0, 20),
        ...(Array.isArray(data.options) ? { options: data.options.filter((o): o is string => typeof o === "string").slice(0, 16).map((o) => o.slice(0, 60)) } : {}),
      }]];
    }));
    return [{ id: item.id.slice(0, 100), name: item.name.slice(0, 120),
      ...(typeof item.type === "string" ? { type: item.type.slice(0, 20) } : {}),
      ...(typeof item.uses === "number" ? { uses: item.uses } : {}),
      ...(typeof item.width === "number" ? { width: item.width } : {}),
      ...(typeof item.height === "number" ? { height: item.height } : {}),
      properties }];
  });
}

const SYSTEM = [
  UX_DIRECT_DESIGN_ROLE + " Users can give a short request. Infer the design procedure and execute the full playbook automatically without asking them to repeat it.",
  "Determine the scope from the selected node. If the selected node is a card, component, widget, row, or other sub-screen component, create a variation of that component only and keep its content inside that component's dimensions. Do not invent screen navigation, unrelated sections, or full-screen chrome for a component selection. If the selected node is a complete screen, create a screen variation.",
  "Before designing, extract a preservation inventory from the selected layer tree: every meaningful label, value, amount, date, status, indicator, icon role, repeated row, action, and relationship. Keep each item unless the user's requested change explicitly removes or changes it. If something is not legible in the screenshot, trust exact source text in the layer tree.",
  "Use actual native Figma Auto Layout, not merely an arrangement that resembles it. Set FRAME.layoutMode to VERTICAL for content stacks/cards, HORIZONTAL for tabs, inline metric rows and action bars. Set itemSpacing, four padding values, primary/counter alignment, and axis sizing. For direct children of Auto Layout parents use layoutSizingHorizontal/layoutSizingVertical = HUG, FILL or FIXED intentionally; ordinary text in vertical stacks normally FILLs width and uses textAutoResize=HEIGHT. Use layoutPositioning=ABSOLUTE only for real overlays (status badges, progress-labels over rings, backplates, decorative art); preserve their coordinates. In an Auto Layout parent, child order is the flow order and x/y is ignored for AUTO-positioned children. Do not claim a feature unless the read-back shows its native properties.",
  "A short prompt must be mapped to a concrete design objective. Keep everything else stable: product context, information architecture, content, interaction meaning and source visual language. Make deliberate, restrained improvements; do not simplify away meaningful content merely to make the canvas look cleaner.",
  "You are UX Direct's native Figma design agent. The user explicitly requested a design action.",
  "CONTENT DENSITY AND PAINT CONTRACT: at least 30% of all native nodes must be TEXT, with at least 6 meaningful task-specific text layers (or every meaningful source text item if the selection has fewer). Put actual labels, values, dates, statuses and action copy in TEXT nodes; never use rectangles as substitutes for readable copy. Every FRAME must declare color for an intentional visible surface or noFill:true for a transparent structural wrapper. Keep normal Auto Layout child widths compatible with parent content padding; use FILL when the parent should determine the effective width.",
  "Return ONLY one JSON object. Required root keys: summary (string), frame ({name,width,height,backgroundColor}), elements (3–8 meaningful top-level FRAME section containers and 18–80 native nodes total). Optional root key learningCandidate: null or {activate:true,title,normalizedRule,rationale,scopeKey,feedbackKind,keywords,originalLanguage}; include it only if this task produced one durable reusable design or execution lesson, never as a task summary. Do not include client-specific names in cross-user or domain-wide rules, raw requirements, screen text, node IDs, screenshots or private facts. Use the narrowest safe scope; the backend validates, scopes, deduplicates and applies the existing 50% relevance threshold. Each node MUST include type, name, x, y, width, height. Allowed type values: RECTANGLE, ELLIPSE, TEXT, LINE, FRAME, POLYGON, STAR, INSTANCE. INSTANCE places a real design-system component: it needs componentId (an exact id from canvas.components) and optional instanceProperties ({propertyName: value}) to pick variants and override text/booleans using the property names listed for that component; it cannot have children. ELLIPSE may use arcData:{startingAngle,endingAngle,innerRadius} with radian angles and endingAngle > startingAngle for native progress arcs/rings. Use color: \"#RRGGBB\" for fill, NOT a fill key. TEXT layers must include text. FRAME nodes may include a children array recursively; only FRAME can contain children. Use noFill:true for transparent structural wrappers, but use visibly styled FRAMEs for cards/surfaces. Do not flatten everything into direct layers. Do not use markdown fences.",
  "Analyse BOTH the attached rendered screen image and native layer tree before planning. Use the image to understand visual hierarchy, alignment, density, spacing, contrast, components, states and design language; use the layer tree for exact text, names, geometry, typography and paint values.",
  "Do not replace an existing task-specific screen with a generic dashboard, generic landing page, or repeated stack of similar cards. Preserve the selected screen's purpose, key content, taxonomy and useful visual patterns. Reuse its components when possible, then improve professional craft, consistency, readability, alignment, action priority and visual rhythm.",
  "Prefer evidence-grounded product content and component patterns. If values are unknown, label financial amounts as sample. Never claim visual analysis when no image was supplied.",
  "Create a polished, high-fidelity native Figma screen using only native shapes and text layers. Do not use images, external assets, or invented APIs.",
  "Use a real Figma layer tree appropriate to selection scope: for a full screen, create meaningful screen sections; for a component, create meaningful internal groups such as Header & status, Primary information, Supporting detail, Progress/indicators and Actions only when those concepts exist in the source. Create 3–6 suitable top-level FRAME groups with names that describe their actual contents, not boilerplate section names. If the source has one enclosing card containing a summary and a breakdown, keep both within one styled outer card FRAME and use an inner divider or surface split. Keep status badges and overlays nested with the card they belong to. Nest row labels and figures together. Use 3 hierarchy levels where the content warrants them; never create empty wrappers just to meet a count. The output should be easy to inspect in Figma's layers panel, not a pile of siblings.",
  "Coordinates are relative to each immediate parent frame's top-left, not global screen coordinates. Auto Layout children flow in array order; do not emit different content nodes at the same simulated coordinates as a substitute for layout. Use layoutSizingHorizontal and layoutSizingVertical explicitly on children of Auto Layout frames. Use layoutPositioning=ABSOLUTE plus x/y only for overlays. Draw backplates behind the content and mark the backplate ABSOLUTE inside an Auto Layout container. Use noFill:true for transparent structural wrappers; styled card frames should have their own background, corner radius and optional subtle stroke/shadow. Do not add a giant empty background inside a small selected card.",
  "For a mobile 360×800 design, use consistent 16–24 px side margins, a deliberate vertical rhythm, a clear type scale (screen title 22–26, section headings 17–20, key amounts 24–30, body 13–16, muted metadata 11–13), high contrast, and visible space between sections. Match the selected screen's visual system and information density rather than inventing a new generic template. Do not fill empty space with random cards.",
  "Use Inter as fontFamily and Regular or Medium as fontStyle when available. Define a coherent spacing scale, typography scale, surface palette and accent usage from the source screenshot/layers. For dark screens, retain the dark canvas and source's card/surface contrast; don't put a single grey slab in an otherwise black screen. Use moderate, consistent corner radii, separator lines only where useful, and strong text contrast. Keep copy and visible values faithful to the selection; never invent features just to decorate a screen.",
  "Preserve the source's user intent, content taxonomy, and brand tone while producing a genuinely improved variation rather than copying its layout mechanically. Preserve every visible meaningful datum and repeated row. Use the selected frame's actual scope and size. Keep the source untouched.",
  "For finance designs (banking, lending, payments, insurance, investing), emphasize transparency, clear amount/date/status hierarchy, user control and accessible legibility. Never make up actual interest rates, contractual terms, or legal-compliance claims. Label illustrative financial values as sample.",
  "Keep all elements within frame bounds, use reasonable minimum touch targets for CTAs, and include the primary action and meaningful secondary paths where appropriate. Limit to 80 elements and use only supported properties.",
  "CRITICAL GEOMETRY CHECK BEFORE RETURNING: check every sibling for accidental overlap and make each text box wide/tall enough for its full copy. Never put different labels or amounts at the same coordinates. When the source uses one enclosing loan card, keep the summary and loan-wise breakdown inside the same outer card FRAME with the source's surface split; do not turn them into unrelated peer cards. Keep the status badge inside that card at its top-right edge and preserve the right-chevron/action cue. Avoid giant empty panels and never invent cards to fill scrollable whitespace.",
  "Progress indicators must preserve their meaning. Do not replace a partial progress ring (for example 60% paid) with a solid disc. Use a native ELLIPSE arcData for the progress segment (radian angles, endingAngle > startingAngle, innerRadius about 0.68–0.8), plus a muted full-circle track and centered percentage/status text. Keep the indicator layers inside a named Progress indicator FRAME. Use arcData whenever the source has a partial progress ring.",
  "Before returning the first plan, check text and numeric-value collisions, clipping, source-content omissions, card boundaries, status badge placement, progress-ring semantics and button hierarchy. UX Direct runs a bounded native read-back + rendered screenshot review after creation; choose robust Auto Layout and preserve overlays so the repair step can make surgical fixes. Do not intentionally truncate meaningful text.",
  "Return a concise user-facing summary of what you designed, not hidden reasoning. Never return null, an array at the root, a tool call, or explanatory text. Return one complete JSON object with summary, frame and elements keys; use learningCandidate:null when there is no durable reusable lesson."
].join("\n");

// Block mode (default): the model returns a short semantic block spec and
// src/figma-agent/block-spec.ts renders the native layer tree deterministically.
// Set UXD_FIGMA_PLAN_MODE=legacy to roll back to model-authored layer trees.
const LEARNING_CANDIDATE_RULE = "Optional root key learningCandidate: null or {activate:true,title,normalizedRule,rationale,scopeKey,feedbackKind,keywords,originalLanguage}; include it only if this task produced one durable reusable design or execution lesson, never as a task summary. Do not include client-specific names in cross-user or domain-wide rules, raw requirements, screen text, node IDs, screenshots or private facts.";
const BLOCK_SYSTEM = [
  UX_DIRECT_DESIGN_ROLE + " Users can give a short request. Infer the design procedure and execute the full playbook automatically without asking them to repeat it.",
  "You are UX Direct's native Figma design agent. The user explicitly requested a design action. You plan the content and structure; UX Direct's renderer builds the native Figma layers.",
  "Determine the scope from the selected node. If it is a card, component, widget or row, design a variation of that component only: no screen navigation, app bars or unrelated sections. If it is a complete screen, design a screen variation.",
  "Before designing, extract a preservation inventory from the selected layer tree: every meaningful label, value, amount, date, status, indicator, repeated row and action. Keep each item unless the user's request explicitly removes or changes it. If something is not legible in the screenshot, trust the exact source text in the layer tree.",
  "Analyse BOTH the attached rendered screen image (when present) and the native layer tree. Use the image for hierarchy, grouping, density and colours; use the layer tree for exact text and values.",
  "Map the short prompt to a concrete design objective and keep everything else stable: product context, information architecture, content, interaction meaning and the source's colours (copy them into theme). Do not replace a task-specific screen with a generic dashboard or a stack of similar cards; do not invent features to fill space.",
  "Group content the way a senior product designer would: one clear primary action, related values together in one card, status next to what it describes, secondary detail in lists.",
  "For finance designs (banking, lending, payments, insurance, investing), emphasize transparency, clear amount/date/status hierarchy, user control and accessible legibility. Never make up actual interest rates, contractual terms or legal-compliance claims; label illustrative financial values as sample.",
  "Progress indicators must keep their meaning: a partial ring (for example 60% paid) is a progress_ring with percent 60, never a solid shape.",
  BLOCK_SPEC_CONTRACT,
  "EXAMPLE OF THE SHAPE ONLY (never copy its content): " + BLOCK_SPEC_EXAMPLE,
  LEARNING_CANDIDATE_RULE,
  "Return one complete JSON object with summary, frame, theme and sections; use learningCandidate:null when there is no durable reusable lesson. No markdown fences, explanation or reasoning.",
].join("\n");

export async function OPTIONS(request: Request) {
  if (!allowedOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: cors(request) });
  return new Response(null, { status: 204, headers: cors(request) });
}

export async function POST(request: Request) {
  const requestStartedAt = Date.now();
  const headers = cors(request);
  if (!allowedOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  const activeProvider = await getResolvedActiveChatProvider();
  const key = activeProvider.apiKey;
  if (!activeProvider.configured || !key) return NextResponse.json({
    error: activeProvider.configurationError || activeProvider.label + " is not configured on the UX Direct Worker.",
    provider: activeProvider.label,
  }, { status: 503, headers });

  let input: unknown;
  try { input = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400, headers }); }
  const requestSchema = z.object({
    prompt: z.string().trim().min(2).max(5000),
    model: z.string().trim().min(1).max(100).optional(),
    canvas: z.unknown(),
    renderedScreen: z.string().max(RENDERED_IMAGE_MAX_CHARS).nullable().optional(),
    referenceImage: z.string().max(250000).nullable().optional(),
    visualCaptureWarning: z.string().max(400).optional(),
    /** Plugin build features; plugins without "clone" cannot run CLONE elements (older zips). */
    capabilities: z.array(z.string().trim().max(40)).max(20).optional(),
    /** Position in a "Create N variations" batch (0-based); later ones get a different direction. */
    variation: z.object({ index: z.number().int().min(0).max(3), count: z.number().int().min(1).max(4) }).optional(),
    /** States pack: render the empty / loading / error / success version of the selected screen. */
    state: z.enum(SCREEN_STATES).optional(),
    /** "create": nothing selected, build a new screen from the prompt (0-to-1). */
    mode: z.enum(["create"]).optional(),
    /** Target frame size for create mode; defaults by platform (360×800 mobile, 1440×1024 web). */
    frame: z.object({ width: z.number().int().min(200).max(2400), height: z.number().int().min(200).max(4000) }).strict().optional(),
    /** The file's own design rules (spacing/radius/type scales, colours, tone), stored in the Figma file. */
    designRules: z.string().max(4000).optional(),
  }).strict();
  const parsedInput = requestSchema.safeParse(input);
  if (!parsedInput.success) return NextResponse.json({ error: "Invalid Figma agent request.", details: parsedInput.error.issues.map((issue) => (issue.path.length ? issue.path.join(".") + ": " : "request: ") + issue.message) }, { status: 400, headers });
  // Ignore a model override from older plugin UI builds. Figma generation is intentionally
  // locked to OpenRouter Auto's LOW cost tier to prevent app-level model fan-out.
  const renderedScreen = typeof parsedInput.data.renderedScreen === "string" &&
    parsedInput.data.renderedScreen.length <= RENDERED_IMAGE_MAX_CHARS &&
    new RegExp("^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$").test(parsedInput.data.renderedScreen)
    ? parsedInput.data.renderedScreen : null;
  const referenceImage = typeof parsedInput.data.referenceImage === "string" &&
    new RegExp("^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$").test(parsedInput.data.referenceImage)
    ? parsedInput.data.referenceImage : null;
  const createMode = parsedInput.data.mode === "create";
  if (createMode && parsedInput.data.state) return NextResponse.json({ error: "A screen state needs a selected screen; create mode builds a new one." }, { status: 400, headers });
  const createSize = createMode ? createFrameSize(parsedInput.data.prompt, parsedInput.data.frame) : null;
  // Create mode: an empty virtual frame of the target size plus the file's real component catalogue.
  const requestCanvas: unknown = createSize ? createModeCanvas(parsedInput.data.canvas, createSize, parsedInput.data.prompt) : parsedInput.data.canvas;
  const canvas = compactCanvas(requestCanvas);
  // Uncompacted read-back: carries image fills, corner radii and deep icon layers for source fidelity.
  const rawSourceCanvas = requestCanvas && typeof requestCanvas === "object" && !Array.isArray(requestCanvas)
    ? requestCanvas as Record<string, unknown> : null;
  const pluginCanClone = (parsedInput.data.capabilities ?? []).includes("clone");
  const selectedRoot = Array.isArray(canvas.nodes) && canvas.nodes[0] && typeof canvas.nodes[0] === "object"
    ? canvas.nodes[0] as Record<string, unknown> : {};
  const selectedName = typeof selectedRoot.name === "string" ? selectedRoot.name : "";
  const selectedType = typeof selectedRoot.type === "string" ? selectedRoot.type.toUpperCase() : "";
  const selectedWidth = typeof selectedRoot.width === "number" ? selectedRoot.width : 0;
  const selectedHeight = typeof selectedRoot.height === "number" ? selectedRoot.height : 0;
  const componentSelection = !createMode && ["COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP"].includes(selectedType) ||
    (selectedWidth > 0 && selectedWidth <= 520 && selectedHeight > 0 && selectedHeight <= 560 &&
      /\b(card|component|widget|tile|row|button|panel|item|summary|breakdown|loan)\b/i.test(selectedName) &&
      !/\b(screen|page|dashboard|flow)\b/i.test(selectedName));
  const designScope = createMode ? CREATE_DESIGN_SCOPE : componentSelection ? "selected_component_or_card" : "selected_screen_or_frame";
  // State runs (empty/loading/...) keep their own verified examples, so they never steer a normal
  // improve toward an empty screen, and a state gets examples of the same state.
  const exampleScope = parsedInput.data.state ? designScope + ":state-" + parsedInput.data.state : designScope;
  const blockMode = (process.env.UXD_FIGMA_PLAN_MODE || "blocks").trim().toLowerCase() !== "legacy";
  const blockOperatingContract = [
    "Treat the user's short prompt as the requested design change, not as the full procedure. Apply the built-in senior designer workflow automatically.",
    "Inventory and preserve all meaningful source text, labels, values, amounts, dates, statuses, indicators, repeated rows and relationships unless the user explicitly asks to change them. Copy them into block fields exactly.",
    "Translate only the requested improvement into a meaningful variation; preserve the source product identity and its colours (theme).",
    "DESIGN SYSTEM FIRST: figmaCanvas.components lists the file's components ranked by use. For a button, input, tab, chip, badge, list row, nav bar or other control that a listed component provides, use a component block with its exact componentId and set variants/labels through instanceProperties using only the listed property names and options.",
    "After creation the plugin runs one rendered screenshot + native layer review and may perform one bounded surgical repair. Preserve the source frame.",
  ];
  const userContext = JSON.stringify({
    prompt: parsedInput.data.prompt,
    designScope,
    selectedNode: { name: selectedName, type: selectedType, width: selectedWidth, height: selectedHeight },
    operatingContract: createMode ? CREATE_OPERATING_CONTRACT : blockMode ? blockOperatingContract : [
      "Treat the user's short prompt as the requested design change, not as the full procedure. Apply the built-in senior designer and expert Figma workflow automatically.",
      "Inventory and preserve all meaningful source text, labels, values, amounts, dates, statuses, indicators, icons, repeated rows, and relationships unless the user explicitly asks to change them.",
      "Use both the rendered screenshot (when available) and native layer tree to infer visual style, layout, information hierarchy, reusable patterns, and content density before planning. If the user also attached a separate reference image, use it as visual inspiration or as content only when requested; never confuse it with the source screenshot or invent a successful asset insertion.",
      "Translate only the requested improvement into a meaningful variation; preserve the source product identity and do not replace specific UI with generic cards.",
      "Build editable semantic FRAME containers with logically nested layers. Use native Auto Layout and modern HUG/FILL/FIXED sizing on content stacks, card internals, tabs, repeated information rows and actions. A normal child in an Auto Layout parent should not rely on x/y; reserve layoutPositioning=ABSOLUTE for true overlays and intentionally layered indicators.",
      "When the local style catalogue contains a suitable style, reuse exact paintStyleId/textStyleId/effectStyleId/gridStyleId rather than recreating equivalent colors or typography. Use text styles only on TEXT nodes and reference only IDs from the supplied catalogue.",
      "When local variables/collections are supplied, use semantic names to guide consistent design. Never invent variable IDs or claim that a token was bound unless a native binding operation is verified.",
      "DESIGN SYSTEM FIRST: canvas.components lists the file's components ranked by use. When a planned element is a button, input, tab, chip, badge, list row, icon, avatar, nav bar or other control that a listed component provides, emit {type:'INSTANCE', componentId:'<exact id>', name, x, y, width, height, instanceProperties:{...}} instead of drawing it from FRAME/RECTANGLE/TEXT. Choose variants and override labels through instanceProperties using only the property names and options listed for that component. If the source already uses an instance of a component, keep using that component.",
      "After native-layer creation, the plugin runs one rendered screenshot + native layer review, may perform one bounded schema-validated surgical repair, then reads and reviews the result once more. Preserve the source frame."
    ],
    visualCapture: createMode ? "Create mode: there is no source screen to capture." : renderedScreen ? "Rendered selected-node image is attached." :
      parsedInput.data.visualCaptureWarning || "No rendered image available; use native layer evidence and do not claim visual inspection.",
    referenceImage: referenceImage ? "A user-attached reference image is included separately from the source screenshot." : null,
    figmaCanvas: canvas,
  });
  if (userContext.length > 200000) return NextResponse.json({ error: "Selection context is too large. Select a smaller frame or reduce the number of layers." }, { status: 413, headers });

  const taskRunId = randomUUID();
  const taskProject = resolveFigmaTaskProject(parsedInput.data.prompt);
  const taskScope = resolveFigmaTaskScope(taskProject, parsedInput.data.prompt);

  // Role switcher + domain detection, then the parallel sub-agents (detector, UX analyst,
  // component scout). They run alongside brain retrieval; their grounded brief only adds
  // planner instructions and never changes designScope, block-spec rendering or the gates.
  const taskRole = detectTaskRole(parsedInput.data.prompt);
  const sourceTexts = collectSourceTextInventory(Array.isArray(canvas.nodes) ? canvas.nodes : []).map((item) => item.text);
  const keywordDomain = detectDomain(parsedInput.data.prompt, sourceTexts);
  const fallbackBrief: AgentBrief = { domain: keywordDomain.domain, domainSource: keywordDomain.score ? "keywords" : "default",
    instructions: roleInstructions(taskRole, keywordDomain.domain), runs: [] };
  // Wireframes keep the source content and only restyle, so the agents add latency for little gain.
  const agentBriefPromise: Promise<AgentBrief> = subAgentsEnabled() && taskRole.id !== "wireframe"
    ? runSubAgents({
      prompt: parsedInput.data.prompt, role: taskRole, designScope,
      selectedNode: { name: selectedName, type: selectedType, width: selectedWidth, height: selectedHeight },
      sourceTexts, components: Array.isArray(canvas.components) ? canvas.components as Array<Record<string, unknown>> : [],
      renderedScreen, origin: new URL(request.url).origin,
    }, { waitMs: PLANNER_AGENT_WAIT_MS }).catch(() => fallbackBrief)
    : Promise.resolve(fallbackBrief);
  const agentsStartedAt = Date.now();
  // Independent of brain retrieval, so both lookups run at the same time.
  const variationIndex = parsedInput.data.variation?.index ?? 0;
  // Every requested variation gets its own direction; index 0 used to be a plain improve, so
  // "2 variations" gave one near-copy of the improve output (finding 47).
  const variationDirection = parsedInput.data.variation ? variationIndex + 1 : 0;
  // Later variations must not be anchored to the same verified structure as the first.
  const verifiedExamplePromise = blockMode && !parsedInput.data.variation
    ? loadVerifiedExample(taskScope, exampleScope).catch(() => "")
    : Promise.resolve("");
  let brain: BrainContextPromptInput = { contextText: "", status: "degraded", memoryCount: 0, knowledgeChunkCount: 0, durationMs: 0 };
  let taskRetrieval: RetrievalRecord = { status: "degraded", memoryIds: [], chunkIds: [], chars: 0 };
  const brainStarted = Date.now();
  try {
    // Usually 0.5–3 s; a cold Neon/R2 path once took 12.9 s (finding 64). Cap it so the model
    // call is never held up: past the cap the run continues without brain context.
    const retrieved = await withTimeout(retrieveBrainContext({
      query: buildBrainQuery({ prompt: parsedInput.data.prompt, frameName: selectedName, designScope,
        nodes: Array.isArray(canvas.nodes) ? canvas.nodes : [] }),
      scopeKeys: resolveBrainScopes(parsedInput.data.prompt + "\n" + JSON.stringify(canvas.nodes).slice(0, 1500)),
      // Tokens are free and the planner prompt is ~21k tokens: a 5k-char brain slice was the
      // smallest part of it. Give the planner up to 12 memories / ~16k chars of team knowledge.
      limit: 12,
      maxChars: 16000,
      // Design memories only: policy and workflow rows ("Automatic Learning Policy", ownership
      // contracts) were the most-retrieved memories yet carry no design guidance.
      memoryTypes: FIGMA_MEMORY_TYPES,
      includeKnowledge: true,
    }), BRAIN_WAIT_MS);
    brain = {
      contextText: retrieved.contextText.slice(0, 17000),
      status: retrieved.retrieval.status,
      memoryCount: Math.max(0, retrieved.retrieval.memoryCount || 0),
      knowledgeChunkCount: Math.max(0, retrieved.retrieval.knowledgeChunkCount || 0),
      durationMs: Date.now() - brainStarted,
    };
    taskRetrieval = { status: retrieved.retrieval.status, memoryIds: retrieved.retrieval.memoryIds,
      chunkIds: retrieved.retrieval.chunkIds, chars: retrieved.retrieval.chars };
  } catch {
    brain = { contextText: "", status: "degraded", memoryCount: 0, knowledgeChunkCount: 0, durationMs: Date.now() - brainStarted };
  }
  // Persist the run before model work starts so a fast completion cannot race a late INSERT.
  const taskRunStarted = startTaskRun({ id: taskRunId, projectKey: taskScope, title: "Figma task", requestSummary: parsedInput.data.prompt, retrieval: taskRetrieval });

  // Sample data follows the request, the file's design rules or the canvas's own currency; ₹/India only without a signal.
  const contentLocale = inferContentLocale({ prompt: parsedInput.data.prompt, designRules: parsedInput.data.designRules,
    texts: canvasTexts(parsedInput.data.canvas) });
  const localeLine = contentLocaleInstruction(contentLocale);
  const scopeInstructions = createSize ? createScopeInstructions(createSize, localeLine) : (componentSelection
    ? "TARGET SCOPE: COMPONENT/CARD. The selected source is " + selectedName + " at " + selectedWidth + "×" + selectedHeight + ". Create only a high-quality component variation, preserving all source data and relationships. Prefer card header, status badge, key values, progress indicator, secondary rows and actions when these exist. Use nested card/row FRAMEs and appropriate Auto Layout; no whole-screen navbar or unrelated screen sections."
    : "TARGET SCOPE: FULL SCREEN/FRAME. Preserve the screen's information architecture and complete content inventory. Structure navigation, tabs, summary cards, repeated rows, supporting detail and actions in meaningful native FRAMEs with suitable Auto Layout.") + "\n" + localeLine;
  // A verified spec from this project (structure only) steers whichever model `auto` picks
  // toward the same block choices that already passed the Figma quality gate.
  const [verifiedExample] = await Promise.all([verifiedExamplePromise, taskRunStarted]);
  // Speed first: the planner waits at most 6 s for the sub-agent notes (they run in parallel
  // with brain retrieval). Waiting up to 40 s was idle time on every run.
  const agentBrief = await Promise.race([agentBriefPromise,
    // The deadline counts from when the agents started, not from here: brain retrieval and the
    // run insert already ran in parallel with them, so a slow insert no longer adds 6 s more.
    new Promise<AgentBrief>((resolve) => setTimeout(() => resolve(fallbackBrief), Math.max(0, agentsStartedAt + PLANNER_AGENT_WAIT_MS + 500 - Date.now())))]);
  const agentsMs = Date.now() - agentsStartedAt;
  const exampleInstructions = verifiedExample
    ? "\nVERIFIED TEAM EXAMPLE — the block structure of an earlier output that passed UX Direct's quality gate. Texts are replaced by <source text>. Follow its way of choosing sections and blocks for similar content; never copy it, and use only this screen's real content: " + verifiedExample
    : "";
  const designRulesInstructions = designRulesBlock(parsedInput.data.designRules);
  const stateInstructions = parsedInput.data.state ? "\n" + STATE_BRIEFS[parsedInput.data.state] : "";
  const system = buildBrainSystemPrompt((blockMode ? BLOCK_SYSTEM : SYSTEM) + "\n" + scopeInstructions + stateInstructions + designRulesInstructions + "\n" + agentBrief.instructions + "\n" + designerPersona(taskRole, parsedInput.data.prompt) + exampleInstructions, brain);
  const endpoint = activeProvider.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  // OpenRouter uses the quality-first model chain; FreeLLMAPI uses its configured free-model chain.
  // Both are bounded by compact retry and the shared generation deadline.
  const hasVisionInput = Boolean(renderedScreen || referenceImage);
  const models = figmaModelChain(activeProvider, hasVisionInput, FIGMA_AGENT_MODELS.map((entry) => entry.id));
  const isFreeLlmApi = activeProvider.id === "freellmapi";
  const errors: string[] = [];
  let validationFeedback = "";
  const recoveryContext = JSON.stringify({
    prompt: parsedInput.data.prompt,
    designScope,
    selectedNode: { name: selectedName, type: selectedType, width: selectedWidth, height: selectedHeight },
    screenshot: renderedScreen ? "Rendered screenshot attached to this request." : "No screenshot available; use native layer evidence only.",
    figmaCanvas: compactRecoveryCanvas(canvas),
    sourceTextInventory: collectSourceTextInventory(Array.isArray(canvas.nodes) ? canvas.nodes : []),
  });
  const recoverySystem = [
    UX_DIRECT_DESIGN_ROLE,
    createMode ? "Create a NEW native Figma screen from the user prompt; there is no source screen." : "Create an improved native Figma variation of the selected source. The user prompt is the design change, not the procedure.",
    scopeInstructions,
    roleInstructions(taskRole, agentBrief.domain),
    designRulesInstructions.trim(),
    "Preserve the screen/component scope, all meaningful source text and financial values, status, date, labels, rows, actions and relationships. Do not redesign it as a generic dashboard or generic stack of cards.",
    "SOURCE TEXT INVENTORY is an explicit checklist from the selected native Figma tree. Preserve every listed text string exactly, including short statuses such as Current, unless the user's request specifically asks to change/remove that exact string.",
    "Use the attached screenshot and source layers when available. Use semantic nested FRAMEs, Auto Layout for suitable cards and rows, clear hierarchy, strong contrast, consistent spacing and editable native shapes/text. Do not invent contractual financial details.",
    "CONTENT DENSITY AND PAINT CONTRACT: at least 30% of all native nodes must be TEXT, with at least 6 meaningful task-specific text layers (or every meaningful source text item if the selection has fewer). Put actual labels, values, dates, statuses and action copy in TEXT nodes. Every FRAME must declare color for a visible surface or noFill:true when transparent. Make Auto Layout widths and paddings compatible; use FILL only when parent content width should determine the effective width.",
    "Return one complete JSON object only with root keys summary (string), frame ({name,width,height,backgroundColor}), elements (an array of 3–6 meaningful populated FRAME section containers), and learningCandidate:null. Every element must use supported native Figma fields. This is a schema contract, not text to copy. No markdown, explanation or reasoning.",
    "OUTPUT BUDGET: use 3–6 meaningful top-level FRAME groups based on the actual screen; target 28–42 native nodes total INCLUDING nested children. Do not create a separate top-level group for a badge that belongs inside a card. Preserve every source label, amount, value, status, date and action. Keep every layer purposeful; do not add decorative placeholders to hit a count. Finish every string, array, object and the final closing brace.",
    "Every node must have type, name, x, y, width and height. Types: FRAME, RECTANGLE, ELLIPSE, TEXT, LINE, POLYGON, STAR, INSTANCE (componentId from canvas.components plus optional instanceProperties; no children). ELLIPSE may include arcData:{startingAngle,endingAngle,innerRadius} with radian angles and endingAngle greater than startingAngle. TEXT must have text. Only FRAME can contain children. Coordinates must be relative to the immediate parent. Use color:'#RRGGBB' and noFill:true only for transparent structural frames.",
    "Do not include a learningCandidate unless there is a durable reusable lesson. If none, set learningCandidate:null.",
  ].join("\n");
  const blockRecoverySystem = [
    UX_DIRECT_DESIGN_ROLE,
    createMode ? "Create a NEW native Figma screen from the user prompt as a BLOCK SPEC; there is no source screen, so ignore source-text rules below." : "Create an improved native Figma variation of the selected source as a BLOCK SPEC. The user prompt is the design change, not the procedure.",
    scopeInstructions,
    roleInstructions(taskRole, agentBrief.domain),
    designRulesInstructions.trim(),
    "SOURCE TEXT INVENTORY is an explicit checklist from the selected native Figma tree. Copy every listed text string exactly into block fields, including short statuses such as Current, unless the user's request specifically asks to change/remove that exact string.",
    "Do not redesign it as a generic dashboard. Do not invent contractual financial details.",
    BLOCK_SPEC_CONTRACT,
    "OUTPUT BUDGET: 3–6 sections and 10–22 blocks. Prefer list over many single rows. Finish every string, array, object and the final closing brace. learningCandidate:null. No markdown, explanation or reasoning.",
  ].join("\n");
  const generationStartedAt = Date.now();
  // OpenRouter sends HTTP 200 headers immediately and the body only once the full plan is
  // generated, so each attempt needs room for a complete multi-thousand-token plan. One shared
  // deadline keeps the sequential chain bounded.
  const generationDeadlineMs = 200000;
  type BlockSpecInfo = { blocks: number; nodes: number; warnings: string[] };
  type Candidate = {
    stage: "blocks" | "schema" | "quality" | "component" | "style" | "ok";
    error: string;
    feedback: string;
    blockSpec: BlockSpecInfo | null;
    plan?: z.infer<typeof PlanSchema>;
    quality?: ReturnType<typeof auditDesignPlanQuality>;
  };
  type SuccessCandidate = {
    candidate: Candidate; spec: unknown; learningCandidate: unknown; servedModel: string; routed?: string;
    isRecovery: boolean; finishReason: string; modelIndex: number; themeLocked?: boolean; repairedTexts: number;
    /** Rebuilt from the source layers after every model answer failed; never a verified example. */
    sourceFallback?: boolean;
  };
  const catalogueComponentIds = new Set((Array.isArray(canvas.components) ? canvas.components as Array<Record<string, unknown>> : [])
    .map((component) => component.id).filter((id): id is string => typeof id === "string"));
  const styleSets = canvas.styles && typeof canvas.styles === "object" ? canvas.styles as Record<string, unknown> : {};
  const wireframeRequest = promptRequestsWireframe(parsedInput.data.prompt);
  const screenState = parsedInput.data.state ?? null;
  // Gates read the prompt plus the texts the state intentionally drops (header and nav stay guarded).
  const gatePrompt = stateGatePrompt(parsedInput.data.prompt, screenState, rawSourceCanvas ?? canvas);
  /** Every deterministic gate a model answer must pass before anything is written to Figma. */
  const renderCandidate = (candidateInput: unknown): Candidate => {
    // A block spec is rendered deterministically; a raw layer tree (legacy mode or a model
    // that ignored the contract) still goes through the same normalizer and gates.
    let planInput: unknown = candidateInput;
    let blockSpec: BlockSpecInfo | null = null;
    if (isBlockSpec(candidateInput)) {
      const expansion = expandBlockSpec(candidateInput, canvas, { componentSelection, sourceCanvas: rawSourceCanvas, allowClones: pluginCanClone, monochrome: wireframeRequest, contentDropped: stateDropsContent(screenState), skeleton: screenState === "loading" });
      blockSpec = { blocks: expansion.blockCount, nodes: expansion.nodeCount, warnings: expansion.warnings };
      if (!expansion.plan) {
        const issues = expansion.errors.slice(0, 4).join("; ");
        return { stage: "blocks", blockSpec, error: "block spec rejected (" + issues + ")",
          feedback: "The block spec could not be rendered: " + issues + " Return a corrected complete block spec; keep every source text." };
      }
      planInput = expansion.plan;
    }
    const parsedPlan = (blockSpec ? BlockPlanSchema : PlanSchema).safeParse(normalizePlan(planInput, canvas, { trustedSections: blockSpec !== null }));
    if (!parsedPlan.success) {
      const issues = parsedPlan.error.issues.slice(0, 4)
        .map((issue) => issue.path.join(".") + " " + issue.message).join("; ");
      return { stage: "schema", blockSpec, error: "invalid design plan schema (" + issues + ")",
        feedback: "The previous plan failed native Figma schema validation: " + issues + ". Return a corrected complete plan; do not repeat these errors." };
    }
    const quality = auditDesignPlanQuality(parsedPlan.data, canvas, gatePrompt);
    if (!quality.passed) {
      const issues = quality.findings.slice(0, 8)
        .map((finding) => finding.code + ": " + finding.message).join("; ");
      return { stage: "quality", blockSpec, plan: parsedPlan.data, quality, error: "quality preflight rejected plan (" + issues + ")",
        feedback: "The plan failed deterministic pre-write quality checks (score " + quality.score +
          "/100): " + issues + ". Fix the actual content/layout/surface defects. Never omit source labels, values, statuses or actions to simplify layout." };
    }
    const unknownComponentId = (function findUnknown(nodes: unknown[]): string | null {
      for (const entry of nodes) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const node = entry as Record<string, unknown>;
        if (node.type === "INSTANCE" && typeof node.componentId === "string" && !catalogueComponentIds.has(node.componentId)) return node.componentId;
        const nested = Array.isArray(node.children) ? findUnknown(node.children) : null;
        if (nested) return nested;
      }
      return null;
    })(parsedPlan.data.elements as unknown[]);
    if (unknownComponentId) {
      return { stage: "component", blockSpec, error: "INSTANCE references an unknown component ID.",
        feedback: "The previous plan used INSTANCE componentId " + unknownComponentId +
          " which is not in canvas.components. Use an exact listed component id or build that element from native layers." };
    }
    const styleReferences: Array<{ key: string; group: string; node: Record<string, unknown> }> = [];
    const collectStyleReferences = (nodes: unknown[]) => {
      for (const entry of nodes) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const node = entry as Record<string, unknown>;
        for (const [key, group] of [["paintStyleId", "paint"], ["strokeStyleId", "paint"], ["textStyleId", "text"], ["effectStyleId", "effect"], ["gridStyleId", "grid"]] as const) {
          if (typeof node[key] === "string") styleReferences.push({ key, group, node });
        }
        if (Array.isArray(node.children)) collectStyleReferences(node.children);
      }
    };
    collectStyleReferences(parsedPlan.data.elements as unknown[]);
    // Text styles already applied in the source selection (often library styles) are valid too.
    const sourceTextStyleIds = new Set<string>();
    (function collectSourceStyles(nodes: unknown[]) {
      for (const entry of nodes) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const node = entry as Record<string, unknown>;
        if (typeof node.textStyleId === "string") sourceTextStyleIds.add(node.textStyleId);
        if (Array.isArray(node.children)) collectSourceStyles(node.children);
      }
    })(Array.isArray(canvas.nodes) ? canvas.nodes : []);
    const invalidStyle = styleReferences.find(({ key, group, node }) => {
      if (key === "textStyleId" && sourceTextStyleIds.has(String(node[key]))) return false;
      const catalogue = Array.isArray(styleSets[group]) ? styleSets[group] as Array<Record<string, unknown>> : [];
      return !catalogue.some((style) => style.id === node[key]);
    });
    if (invalidStyle) {
      return { stage: "style", blockSpec, error: invalidStyle.key + " references an unknown local " + invalidStyle.group + " style ID.",
        feedback: "The previous plan referenced an unknown local " + invalidStyle.group + " style ID for " +
          invalidStyle.key + ". Remove that invalid reference or use an exact style ID from the supplied catalogue." };
    }
    return { stage: "ok", blockSpec, plan: parsedPlan.data, quality, error: "", feedback: "" };
  };
  // Which model produced what, per attempt, so models can be compared on the same gate.
  const attemptLog: GenerationRecord["attempts"] = [];
  let lastServedModel = "";
  let fallback: SuccessCandidate | null = null;
  // Set when an upstream rejects optional sampling parameters; the retry then omits them.
  let paramsRejected = false;
  // Wall time per model attempt, returned to the plugin so a slow run shows where the time went.
  const attemptTimes: Array<{ attempt: string; ms: number; outcome: string }> = [];
  let inFlight: { attempt: string; startedAt: number } | null = null;
  // Size of the last prompt sent, so a slow model call can be told apart from a huge prompt.
  let promptSize: { textChars: number; approxTokens: number; imageKb: number } | null = null;
  // UX Director agency report (per-designer timing and outcome), when the agency ran.
  let agencyReport: (Omit<AgencyResult, "spec"> & { used: boolean; gate?: string }) | null = null;
  const respond = async (success: SuccessCandidate) => {
    const { candidate } = success;
    // Awaited, not deferred: long runs (100 s+) lost this write after the response went out, and
    // the plugin's finalize then saved metadata without the model (brain monitor, 2026-11-07).
    await recordGeneration(taskRunId, {
      model: success.servedModel, routedVia: success.routed,
      planFormat: candidate.blockSpec ? "blocks" : "elements", designScope: exampleScope,
      qualityScore: candidate.quality?.score, themeLocked: success.themeLocked,
      repairedTexts: success.repairedTexts, attempts: attemptLog,
    }, candidate.blockSpec && !success.sourceFallback ? success.spec : null).catch(() => null);
    return NextResponse.json({
      ok: true,
      taskRunId,
      taskProject,
      retrieval: taskRetrieval,
      plan: candidate.plan,
      planFormat: candidate.blockSpec ? "blocks" : "elements",
      blockSpec: candidate.blockSpec,
      learningCandidate: success.learningCandidate,
      learning: "awaiting-verification",
      model: success.servedModel,
      routedVia: success.routed,
      sourceFallback: success.sourceFallback === true,
      consistency: { themeLocked: success.themeLocked ?? false, restoredSourceTexts: success.repairedTexts, verifiedExample: Boolean(verifiedExample) },
      brain: { status: brain.status, memories: brain.memoryCount, knowledgeChunks: brain.knowledgeChunkCount, latencyMs: brain.durationMs },
      agents: { role: taskRole.id, domain: agentBrief.domain.id, domainSource: agentBrief.domainSource, latencyMs: agentsMs, runs: agentBrief.runs },
      agency: agencyReport,
      visualAnalysis: { imageReceived: !!renderedScreen, layerNodeCount: canvas.nodeCount, warning: parsedInput.data.visualCaptureWarning || null },
      generation: { recoveryAttempted: success.isRecovery, finishReason: success.finishReason, modelIndex: success.modelIndex + 1,
        attempts: attemptLog.length, elapsedMs: Date.now() - generationStartedAt, totalMs: Date.now() - requestStartedAt,
        preModelMs: generationStartedAt - requestStartedAt,
        attemptTimes: [...attemptTimes, ...(inFlight ? [{ attempt: inFlight.attempt, ms: Date.now() - inFlight.startedAt, outcome: "ok" }] : [])],
        prompt: promptSize },
    }, { headers });
  };
  // Studio: one designer (Product, UX or UI Designer, picked by the Director) built the whole screen
  // in the planner answer above. The UX Lead reviews it top to bottom and scores it; the same
  // designer iterates on the notes; the Lead re-reviews, until the score meets the bar or the
  // round/time cap. The Director keeps each new version only if every gate passes, nothing the
  // previous version showed is lost, and it is not worse.
  const studioPass = async (success: SuccessCandidate): Promise<SuccessCandidate> => {
    if (!studioReviewEnabled() || !blockMode || success.sourceFallback || !isBlockSpec(success.spec) || !success.candidate.quality) return success;
    // Close the designer's timing row first so the review time is not counted as model time.
    if (inFlight) { attemptTimes.push({ attempt: inFlight.attempt, ms: Date.now() - inFlight.startedAt, outcome: "ok" }); inFlight = null; }
    const studioStarted = Date.now();
    const timeLeft = () => generationDeadlineMs - (Date.now() - generationStartedAt);
    const origin = new URL(request.url).origin;
    // Coverage is judged on the plugin's full read (the compact planner copy cuts deep card texts),
    // except for a state screen, which drops texts on purpose.
    // Counted, not de-duplicated: three loan cards with the same labels must stay three cards.
    // Logo and chevron glyph texts are decoration: not required, and flagged when shown as content.
    const sourceRead = sourceContentTexts(Array.isArray((rawSourceCanvas ?? canvas).nodes) ? (rawSourceCanvas ?? canvas).nodes as unknown[] : []);
    const fullSource = screenState ? [] : sourceRead.content;
    const shared = { prompt: parsedInput.data.prompt, role: taskRole, sourceTexts: fullSource.length ? fullSource : sourceTexts, decorativeTexts: screenState ? [] : sourceRead.decorative,
      controls: sourceControls(Array.isArray((rawSourceCanvas ?? canvas).nodes) ? (rawSourceCanvas ?? canvas).nodes as unknown[] : []), origin };
    const owner = taskOwner(taskRole, parsedInput.data.prompt);
    // Each seat gets the knowledge for its role (Lead: review checklist, critique format; designer: its craft).
    const knowledgeQuery = parsedInput.data.prompt + " " + taskRole.label + " " + agentBrief.domain.id;
    const [leadKnowledge, designerKnowledge] = await withTimeout(Promise.all([
      seatKnowledge("ux-lead", knowledgeQuery + " review hierarchy consistency critique", agentBrief.domain.id),
      seatKnowledge(owner, knowledgeQuery, agentBrief.domain.id),
    ]), 4000).catch(() => ["", ""]);
    let current = success;
    const models: string[] = [];
    // One compact timing row for the whole pass (the plugin shows 6 rows); details go to the log.
    const ledger: string[] = [];
    const log = (detail: string) => attemptLog.push({ model: "review", result: detail.slice(0, 400) });
    const missingNow = (spec: unknown) => fullSource.length ? missingFromSpec(spec as Record<string, unknown>, fullSource, parsedInput.data.prompt).length : 0;
    /**
     * Director's call on an iteration: it must keep everything the previous version showed (counted,
     * so merged cards fail), must not add invented text, must pass every gate on its own (no
     * restore that dumps texts outside their cards), and must cover the source at least as well.
     */
    let refusal = "";
    let refusalTexts: string[] = [];
    const directorKeeps = (spec: Record<string, unknown>, model?: string): boolean => {
      // Only content counts as lost: dropping a stray logo or chevron text is a fix, not a loss.
      const contentKeys = new Set(fullSource.map((text) => text.toLowerCase().replace(/\s+/g, " ").trim()));
      const lost = lostTexts(current.spec as Record<string, unknown>, spec).filter((text) => !fullSource.length || contentKeys.has(text.toLowerCase().replace(/\s+/g, " ").trim()) || isValueText(text));
      if (lost.length) { refusal = "lost"; refusalTexts = lost.slice(0, 8); log("iteration dropped " + lost.length + " texts (" + lost.slice(0, 4).join(", ") + "); previous version kept"); return false; }
      const known = [...(fullSource.length ? fullSource : sourceTexts), ...sourceRead.decorative];
      const inventedBefore = inventedTexts(current.spec as Record<string, unknown>, known, parsedInput.data.prompt).length;
      const invented = inventedTexts(spec, known, parsedInput.data.prompt);
      if (invented.length > inventedBefore) { refusal = "new text"; refusalTexts = invented.slice(0, 8); log("iteration invented text (" + invented.slice(0, 4).join(", ") + "); previous version kept"); return false; }
      const candidate = renderCandidate(spec);
      const before = missingNow(current.spec);
      const after = missingNow(spec);
      const kept = candidate.stage === "ok" && !!candidate.plan && !!candidate.quality && after <= before;
      log("iteration " + (kept ? "kept" : "refused") + ": " + (candidate.stage !== "ok" ? candidate.stage + ": " + candidate.error : "missing source " + before + "→" + after + ", score " + (current.candidate.quality?.score ?? "?") + "→" + (candidate.quality?.score ?? "?")));
      if (!kept) { refusal = candidate.stage !== "ok" ? "gate" : "coverage"; return false; }
      if (model) models.push(model);
      current = { ...current, candidate, spec };
      return true;
    };
    const rounds = leadMaxRounds();
    let approved = false;
    // Every reviewed version with its Lead score; the Director ships the best one.
    const reviewed: Array<{ version: SuccessCandidate; score: number; models: number }> = [];
    let lastScore: number | null = null;
    for (let round = 1; round <= rounds + 1; round++) {
      if (timeLeft() < 25000) { ledger.push("time"); break; }
      const review = await leadReview(current.spec as Record<string, unknown>, { ...shared, brain: brain.contextText, knowledge: leadKnowledge, round,
        timeoutMs: Math.min(25000, Math.floor(timeLeft() / 4)) }).catch(() => null);
      if (!review) break;
      const actionable = review.notes.filter((entry) => entry.severity !== "low");
      // Show why a score is capped (a deterministic high note), e.g. "55%(missing)".
      const cap = review.notes.find((entry) => entry.severity === "high" && entry.code)?.code;
      ledger.push((review.score ?? "?") + "%" + (cap ? "(" + cap + ")" : ""));
      log("round " + round + " score " + (review.score ?? "?") + " (" + (review.model || "rules") + "): " + (actionable.map((entry) => entry.severity + ": " + entry.issue).join(" | ") || "no fixes"));
      if (review.score !== null) reviewed.push({ version: current, score: review.score, models: models.length });
      approved = leadApproves(review);
      if (approved || !actionable.length || round > rounds) break;
      // An iteration that did not raise the Lead's score stops the loop: more of the same won't help.
      if (round > 1 && lastScore !== null && review.score !== null && review.score <= lastScore) { ledger.push("flat"); break; }
      if (review.score !== null) lastScore = review.score;
      if (timeLeft() < 35000) { ledger.push("time"); break; }
      // The designer gets one more try when the Director refuses for lost or invented text, with
      // exactly what went wrong; a second refusal ends the loop.
      let notes = review.notes;
      let keptIteration = false;
      for (let attempt = 0; attempt < 2 && !keptIteration; attempt++) {
        if (attempt > 0 && (timeLeft() < 35000 || (refusal !== "lost" && refusal !== "new text"))) break;
        const revision = await reviseFromNotes(current.spec as Record<string, unknown>, notes, { ...shared, knowledge: designerKnowledge,
          designRules: designRulesInstructions.trim(), timeoutMs: Math.min(70000, timeLeft() - 25000) });
        if (!revision.spec) { ledger.push("×"); log("iteration failed: " + (revision.error || "no answer")); break; }
        keptIteration = directorKeeps(revision.spec, revision.model);
        if (keptIteration) { ledger.push("→"); break; }
        ledger.push("×" + refusal);
        notes = [{ severity: "high", issue: refusal === "lost"
          ? "Your last iteration dropped source content: " + refusalTexts.join(", ")
          : "Your last iteration added text that is not in the source: " + refusalTexts.join(", "),
        fix: refusal === "lost" ? "Keep every one of these texts, in its own card." : "Remove these texts; use only the source's own words." }, ...review.notes];
      }
      if (!keptIteration) break;
    }
    // Director's final call: the best-scored reviewed version (the earlier one on a tie).
    const best = reviewed.reduce<typeof reviewed[number] | null>((top, entry) => (!top || entry.score > top.score ? entry : top), null);
    if (best && best.version !== current && !approved) {
      current = best.version;
      models.length = best.models;
      log("final: kept the version the Lead scored " + best.score);
    }
    const bar = approved ? " ✓" : reviewed.length ? " (below bar)" : " (unreviewed)";
    attemptTimes.push({ attempt: "review " + ledger.join(" ") + bar, ms: Date.now() - studioStarted, outcome: "ok" });
    return models.length ? { ...current, servedModel: [success.servedModel, ...models].filter(Boolean).join(", ") } : current;
  };
  // UX Director agency: the source screen's sections go to specialist designers in parallel
  // (small calls), the Director merges them and the same gates check the result. A failed gate
  // falls through to the monolithic planner below with most of the 200 s budget left.
  const agencyEligible = agencyEnabled() && blockMode && !createMode && !screenState && !componentSelection && !referenceImage && agencyHandlesRole(taskRole);
  // Designers see only the layer tree; a tree with hidden (unread) content would make them drop it.
  // Judged on the plugin's full read (depth 12), not the planner's compact copy (depth 8), which
  // cuts deep card internals that the plugin did read (finding: frame 15 skipped for 4 "unread" nodes).
  const agencySource = rawSourceCanvas ?? canvas;
  const truncatedNames = agencyEligible ? truncatedContentNames(agencySource) : [];
  if (agencyEligible && truncatedNames.length > 0) {
    attemptTimes.push({ attempt: "section pass skipped: " + truncatedNames.length + " layer(s) not read (" + truncatedNames.slice(0, 4).join(", ") + ")", ms: 0, outcome: "skipped" });
  }
  if (agencyEligible && truncatedNames.length === 0) {
    const agencyStarted = Date.now();
    const agency = await runAgency(agencySource, {
      prompt: parsedInput.data.prompt, role: taskRole,
      directorBrief: agentBrief.instructions, designRules: designRulesInstructions.trim(),
      brain: brain.contextText.slice(0, 6000), origin: new URL(request.url).origin,
    }).catch(() => null);
    if (agency) {
      const { spec: agencySpec, ...report } = agency;
      agencyReport = { ...report, used: false };
      if (agencySpec) {
        const stabilized = stabilizeBlockSpec({ ...agencySpec, frame: { name: selectedName + " · UX Direct" } }, canvas, parsedInput.data.prompt);
        let specInput: unknown = applyVariationDirection(stabilized.spec, variationDirection);
        let candidate = renderCandidate(specInput);
        let repairedTexts = 0;
        if (candidate.stage === "quality" && candidate.plan && candidate.quality?.findings.every((finding) => finding.code === "missing-source-content")) {
          const missing = missingSourceTexts(candidate.plan, canvas, gatePrompt);
          if (missing.length && missing.length <= MAX_REPAIRED_TEXTS) {
            const repairedSpec = appendMissingSourceText(specInput, missing);
            const repaired = renderCandidate(repairedSpec);
            if (repaired.stage === "ok") { candidate = repaired; specInput = repairedSpec; repairedTexts = missing.length; }
          }
        }
        const models = [...new Set(report.runs.map((run) => run.model).filter(Boolean))];
        const designed = report.runs.filter((run) => run.outcome === "designed").length;
        attemptTimes.push({ attempt: "sections " + designed + "/" + report.runs.length + " (" + report.concurrency + " parallel)",
          ms: Date.now() - agencyStarted, outcome: candidate.stage === "ok" ? "ok" : candidate.error.slice(0, 120) });
        // One Timing row per designer, so a section that fell back shows why.
        for (const run of report.runs.filter((entry) => entry.outcome !== "kept")) {
          // Neutral wording: the plugin shows this line, and the team structure stays backend-only.
          attemptTimes.push({ attempt: "· " + run.section, ms: run.ms,
            outcome: run.outcome === "designed"
              ? "ok" + (run.rounds && run.rounds > 1 ? ", " + run.rounds + " rounds" : "") + (run.openIssues ? ", " + run.openIssues + " open" : "") + (run.restoredTexts ? ", +" + run.restoredTexts + " restored" : "")
              : "kept source: " + (run.error || "rejected").slice(0, 100) });
        }
        attemptLog.push({ model: models.join(", ") || "none", result: candidate.stage === "ok" ? "passed" : candidate.stage + ": " + candidate.error });
        if (candidate.stage === "ok" && candidate.plan && candidate.quality) {
          agencyReport = { ...agencyReport, used: true, gate: "ok" };
          return respond({ candidate, spec: specInput, learningCandidate: null, servedModel: models.join(", ") || "auto",
            isRecovery: false, finishReason: "stop", modelIndex: 0, themeLocked: stabilized.themeLocked, repairedTexts });
        }
        agencyReport = { ...agencyReport, gate: candidate.stage + ": " + candidate.error.slice(0, 200) };
      }
    }
  }
  // Only a few free models read images (Gemini, one OpenRouter VL). When those are out of quota or
  // time out, every later attempt goes text-only on the native layer tree, so the gateway can reach
  // Groq, Mistral and Workers AI instead of the deterministic source fallback (2026-11-07: an
  // improve tried five Gemini models in a row, all 429/timeout, then fell back).
  let visionDropped = false;
  modelLoop: for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = models[modelIndex];
    const attemptsForModel = 2;
    // One extra same-mode retry for a transient upstream failure (FreeLLMAPI `auto` 502s while it
    // rotates keys or the tunnel blips), so a hiccup doesn't drop us straight to the compact prompt.
    let transientRetried = false;
    // A compact retry that answered with a rejected spec (not a timeout) gets one repair pass with
    // the validator's feedback while budget remains: a fast model just answered, so a fixed spec
    // beats the source fallback (2026-11-07 retest: mistral-small answered in 21 s with no
    // renderable sections and ~80 s of budget was left unused).
    let compactRejected = false;
    for (let recoveryAttempt = 0; recoveryAttempt < attemptsForModel + (compactRejected ? 1 : 0); recoveryAttempt += 1) {
      const isRecovery = recoveryAttempt >= 1;
      const remainingMs = generationDeadlineMs - (Date.now() - generationStartedAt);
      if (recoveryAttempt === 2 && remainingMs < 35000) {
        errors.push("Not enough budget left to repair the " + model + " compact spec.");
        break modelLoop;
      }
      if (remainingMs < 20000) {
        errors.push("Generation deadline reached before " + model + (isRecovery ? " compact retry" : "") + " could run.");
        break modelLoop;
      }
      // The first FreeLLMAPI attempt also absorbs a sleeping host's cold start.
      const firstAttemptMs = isFreeLlmApi ? FREELLMAPI_FIRST_ATTEMPT_TIMEOUT_MS : 80000;
      const attemptTimeoutMs = Math.min(isRecovery ? (isFreeLlmApi ? FREELLMAPI_RECOVERY_TIMEOUT_MS : 45000) : (modelIndex === 0 ? firstAttemptMs : 70000), remainingMs);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
      const errorsBefore = errors.length;
      inFlight = { attempt: model + (isRecovery ? " compact retry" : ""), startedAt: Date.now() };
      try {
        const validationBlock = validationFeedback
          ? "\n\nAUTOMATED VALIDATION FEEDBACK — fix every listed defect in this new plan before returning JSON:\n" + validationFeedback
          : "";
        const modelUserText = isRecovery
          ? "RECOVERY RETRY: The prior response was absent, incomplete, or invalid. Return a smaller complete JSON object following the exact compact output budget in the system message. Do not continue the old text or explain the failure.\nSOURCE CONTEXT:\n" + recoveryContext + validationBlock
          : (renderedScreen && !visionDropped
            ? "Design a high-fidelity, source-faithful improvement. Combine the rendered screen image with its native layer tree. Avoid generic redesigns. Context:\n" + userContext + validationBlock
            : "Design a source-faithful improvement using native layer evidence only. No rendered image was available, so do not claim visual inspection. Context:\n" + userContext + validationBlock);
        const modelImages: Array<Record<string, unknown>> = [];
        if (renderedScreen && !visionDropped) modelImages.push({ type: "image_url", image_url: { url: renderedScreen } });
        if (referenceImage && !visionDropped) modelImages.push({ type: "image_url", image_url: { url: referenceImage } });
        const systemText = isRecovery ? (blockMode ? blockRecoverySystem : recoverySystem) : system;
        const textChars = systemText.length + modelUserText.length;
        promptSize = { textChars, approxTokens: Math.round(textChars / 3.6),
          imageKb: Math.round(modelImages.reduce((sum, image) => sum + String((image.image_url as { url?: string })?.url || "").length, 0) * 0.75 / 1024) };
        const userContent: string | Array<Record<string, unknown>> = modelImages.length
          ? [{ type: "text", text: modelUserText }, ...modelImages]
          : modelUserText;
        const response = await providerFetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + key,
            "Content-Type": "application/json",
            Accept: "application/json",
            ...figmaRoutingHeaders(activeProvider, { fast: isRecovery, role: isRecovery ? "fast-retry" : blockMode ? gatewaySeat(taskOwner(taskRole, parsedInput.data.prompt)) : "planner" }),
            ...(activeProvider.id === "openrouter" ? {
              "HTTP-Referer": new URL(request.url).origin,
              "X-OpenRouter-Title": "UX Direct Figma Agent",
            } : {}),
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemText },
              { role: "user", content: userContent },
            ],
            ...(activeProvider.id === "openrouter" && model === "openrouter/auto" ? { plugins: [{ id: "auto-router", cost_tier: "low" }] } : {}),
            ...(activeProvider.id === "openrouter" && model === "openai/gpt-6-luna" ? { provider: { sort: "throughput" }, reasoning: { effort: "low" } } : {}),
            // Low temperature for every model `auto` may route to: same input, near-same spec.
            ...(model.startsWith("google/gemini-") ? { temperature: isRecovery ? 0.1 : 0.15 }
              : isFreeLlmApi && !paramsRejected ? { temperature: isRecovery ? 0.1 : 0.2 } : {}),
            // Qwen 3.5 thinks by default; unbounded reasoning spends the attempt before any JSON is written.
            ...(model.startsWith("qwen/") ? { reasoning: isRecovery ? { enabled: false } : { effort: "low" } } : {}),
            // Many free upstream models cap output near 8k tokens and reject larger requests.
            ...figmaMaxTokens(activeProvider, isRecovery ? 6000 : 9000),
            // JSON mode is enabled for the first attempt. Compact retries use normal text mode
            // because some provider/model routes have returned successful but empty choices.
            ...(!isRecovery ? { response_format: { type: "json_object" } } : {}),
          }),
          cache: "no-store",
          signal: controller.signal,
        });
        const responseContentType = response.headers.get("content-type") || "unknown";
        let responseText = "";
        try {
          responseText = await response.text();
        } catch (readError) {
          // An abort while the body is still arriving is a timeout, not an empty body.
          if (controller.signal.aborted) throw readError;
        }
        let rawPayload: unknown = null;
        let responseJsonInvalid = false;
        if (responseText.trim()) {
          try {
            rawPayload = JSON.parse(responseText.replace(/^\uFEFF/, "")) as unknown;
          } catch {
            responseJsonInvalid = true;
          }
        }
        const payload = rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
          ? rawPayload as Record<string, unknown>
          : {};
        const providerError = payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)
          ? payload.error as Record<string, unknown>
          : {};
        if (!response.ok) {
          if (shouldRetryWithoutJsonMode(activeProvider, response.status)) paramsRejected = true;
          attemptLog.push({ model: model + (isRecovery ? " compact retry" : ""), result: "HTTP " + response.status });
          const detail = typeof providerError.message === "string" ? providerError.message.slice(0, 260) : "HTTP " + response.status;
          errors.push(model + (isRecovery ? " compact retry" : "") + ": " + detail);
          if (modelImages.length && [408, 429, 502, 503, 504].includes(response.status)) visionDropped = true;
          // Same-mode retry only for a FAST failure (a tunnel blip). A 5xx after a long wait means
          // the upstream chain already tried its models; repeating it burned ~67 s (finding 61).
          const attemptMs = inFlight ? Date.now() - inFlight.startedAt : 0;
          if (!transientRetried && [408, 429, 500, 502, 503, 504].includes(response.status) && attemptMs < 20000 &&
            generationDeadlineMs - (Date.now() - generationStartedAt) > 45000) {
            transientRetried = true;
            await new Promise((resolve) => setTimeout(resolve, 1500));
            recoveryAttempt -= 1;
            continue;
          }
          // A 5xx after a long wait means the upstream chain already failed through its models;
          // the compact retry then also timed out (60 s) in every observed run, so go straight
          // to the source fallback instead (finding 61, round 5).
          // Unless that attempt carried an image: the text-only retry reaches other providers.
          if ([500, 502, 503, 504].includes(response.status) && attemptMs > 45000 && !(visionDropped && modelImages.length)) break modelLoop;
          // The compact retry runs without JSON mode, which covers free models that reject response_format.
          if (!isRecovery && ([408, 429, 500, 502, 503, 504].includes(response.status) ||
            shouldRetryWithoutJsonMode(activeProvider, response.status))) continue;
          break;
        }
        if (!responseText.trim()) {
          errors.push(model + (isRecovery ? " compact retry" : "") +
            ": provider returned an empty response body (HTTP " + response.status +
            ", content-type=" + responseContentType + ").");
          if (!isRecovery) continue;
          break;
        }
        if (responseJsonInvalid) {
          errors.push(model + (isRecovery ? " compact retry" : "") +
            ": provider returned a non-JSON response body (HTTP " + response.status +
            ", content-type=" + responseContentType + ", chars=" + responseText.length + ").");
          if (!isRecovery) continue;
          break;
        }
        if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
          const payloadType = rawPayload === null ? "null" : Array.isArray(rawPayload) ? "array" : typeof rawPayload;
          errors.push(model + (isRecovery ? " compact retry" : "") +
            ": provider returned a non-object JSON envelope (type=" + payloadType + ").");
          if (!isRecovery) continue;
          break;
        }
        const nestedData = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
          ? payload.data as Record<string, unknown> : {};
        const nestedResponse = payload.response && typeof payload.response === "object" && !Array.isArray(payload.response)
          ? payload.response as Record<string, unknown> : {};
        const nestedResult = payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)
          ? payload.result as Record<string, unknown> : {};
        const responseEnvelope = Array.isArray(payload.choices) ? payload
          : Array.isArray(nestedData.choices) ? nestedData
          : Array.isArray(nestedResponse.choices) ? nestedResponse
          : Array.isArray(nestedResult.choices) ? nestedResult
          : payload;
        const choices = Array.isArray(responseEnvelope.choices) ? responseEnvelope.choices : [];
        const firstChoice = choices[0] && typeof choices[0] === "object" && !Array.isArray(choices[0])
          ? choices[0] as Record<string, unknown>
          : {};
        const providerMessage = firstChoice.message && typeof firstChoice.message === "object" && !Array.isArray(firstChoice.message)
          ? firstChoice.message as Record<string, unknown>
          : {};
        const rawPlan = extractPlanJson(providerMessage.content)
          ?? extractPlanJson(providerMessage.parsed)
          ?? extractPlanJson(providerMessage.tool_calls)
          ?? extractPlanJson(providerMessage)
          ?? extractPlanJson(firstChoice)
          // Some provider adapters wrap OpenAI-compatible or native Gemini output.
          ?? extractPlanJson(payload);
        const finishReason = typeof firstChoice.finish_reason === "string" ? firstChoice.finish_reason : "unknown";
        const nativeFinishReason = typeof firstChoice.native_finish_reason === "string" ? firstChoice.native_finish_reason : "unknown";
        const wasTruncated = finishReason === "length" || nativeFinishReason === "length";
        if (wasTruncated) {
          errors.push(model + (isRecovery ? " compact retry" : "") +
            ": provider hit the output length limit (finish_reason=" + finishReason +
            ", native_finish_reason=" + nativeFinishReason + ", content=" +
            describeModelContent(providerMessage.content) + ").");
          // A valid-looking prefix can still be incomplete. Never write it; retry compactly.
          if (!isRecovery) continue;
          break;
        }
        if (rawPlan === null) {
          const messageKeys = Object.keys(providerMessage).slice(0, 10).join(",") || "none";
          const choiceKeys = Object.keys(firstChoice).slice(0, 10).join(",") || "none";
          errors.push(model + (isRecovery ? " compact retry" : "") +
            ": response contained no extractable design JSON (content=" + describeModelContent(providerMessage.content) +
            ", finish_reason=" + finishReason + ", message_keys=" + messageKeys + ", choice_keys=" + choiceKeys +
            ", tool_calls=" + (Array.isArray(providerMessage.tool_calls) ? providerMessage.tool_calls.length : 0) +
            ", payload_keys=" + (Object.keys(payload).slice(0, 12).join(",") || "none") +
            ", envelope_keys=" + (Object.keys(responseEnvelope).slice(0, 12).join(",") || "none") + ").");
          if (!isRecovery) continue;
          break;
        }
        const rawPlanRecord = rawPlan && typeof rawPlan === "object" && !Array.isArray(rawPlan)
          ? rawPlan as Record<string, unknown>
          : {};
        const learningCandidate = sanitizeInlineLearningCandidate(rawPlanRecord.learningCandidate);
        // FreeLLMAPI `auto` reports the upstream model it actually used.
        const servedModel = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim().slice(0, 160) : model;
        lastServedModel = servedModel;
        const attemptName = servedModel + (isRecovery ? " compact retry" : "");
        // Same palette for the same screen whichever model answered (unless a restyle was asked).
        let specInput: unknown = rawPlan;
        let themeLocked: boolean | undefined;
        if (isBlockSpec(rawPlan)) {
          const stabilized = stabilizeBlockSpec(rawPlan, canvas, parsedInput.data.prompt);
          specInput = applyVariationDirection(stabilized.spec, variationDirection);
          themeLocked = stabilized.themeLocked;
        }
        let candidate = renderCandidate(specInput);
        let repairedTexts = 0;
        // A model that drops a few source strings is repaired deterministically: the text goes
        // back in, so a weaker model can't lose content and doesn't need another attempt.
        if (candidate.stage === "quality" && candidate.plan && isBlockSpec(specInput) &&
            candidate.quality?.findings.every((finding) => finding.code === "missing-source-content")) {
          const missing = missingSourceTexts(candidate.plan, canvas, gatePrompt);
          if (missing.length && missing.length <= MAX_REPAIRED_TEXTS) {
            const repairedSpec = appendMissingSourceText(specInput, missing);
            const repaired = renderCandidate(repairedSpec);
            if (repaired.stage === "ok") {
              const success: SuccessCandidate = { candidate: repaired, spec: repairedSpec, learningCandidate, servedModel,
                routed: routedVia(response), isRecovery, finishReason, modelIndex, themeLocked, repairedTexts: missing.length };
              // Small gaps are fixed now; larger ones first give the model one chance to do better.
              if (missing.length <= 3 || isRecovery) {
                candidate = repaired;
                specInput = repairedSpec;
                repairedTexts = missing.length;
              } else if (!fallback) {
                fallback = success;
                attemptLog.push({ model: attemptName, result: "dropped " + missing.length + " source texts; repaired copy kept as fallback" });
              }
            }
          }
        }
        if (candidate.stage !== "ok" || !candidate.plan || !candidate.quality) {
          validationFeedback = candidate.feedback;
          errors.push(attemptName + ": " + candidate.error);
          if (!attemptLog.some((entry) => entry.model === attemptName)) attemptLog.push({ model: attemptName, result: candidate.stage + ": " + candidate.error });
          if (!isRecovery) continue;
          if (recoveryAttempt === 1 && isFreeLlmApi && validationFeedback) { compactRejected = true; continue; }
          break;
        }
        attemptLog.push({ model: attemptName, result: repairedTexts ? "passed after restoring " + repairedTexts + " source texts" : "passed" });
        return respond(await studioPass({ candidate, spec: specInput, learningCandidate, servedModel, routed: routedVia(response),
          isRecovery, finishReason, modelIndex, themeLocked, repairedTexts }));
      } catch (error) {
        errors.push(model + (isRecovery ? " compact retry" : "") + ": " +
          (controller.signal.aborted ? "timed out after " + attemptTimeoutMs + "ms before the provider finished the response" : error instanceof Error ? error.message.slice(0, 200) : "request failed"));
        if (controller.signal.aborted && (renderedScreen || referenceImage)) visionDropped = true;
        if (!isRecovery) continue;
        break;
      } finally {
        clearTimeout(timer);
        if (inFlight) {
          attemptTimes.push({ attempt: (lastServedModel && lastServedModel !== model ? lastServedModel + " via " : "") + inFlight.attempt,
            ms: Date.now() - inFlight.startedAt, outcome: errors.length > errorsBefore ? errors[errors.length - 1].slice(0, 120) : "ok" });
          inFlight = null;
        }
      }
    }
  }
  // Every attempt missed the gate, but one only dropped source text that was restored.
  if (fallback) return respond(fallback);
  // No model answer was usable: rebuild the screen from its own layers rather than failing.
  // Create mode has no layers to rebuild from, so it reports the failure instead.
  if (blockMode && !createMode) {
    // The full read: the model-facing canvas is cut at depth 6, which dropped every card title,
    // ID, label and amount (they sit 7–8 levels deep) from the fallback (findings 27, 42).
    const baseSpec = sourceFallbackSpec(rawSourceCanvas ?? canvas);
    const sourceSpec = baseSpec && screenState ? stateFallbackSpec(baseSpec, screenState, rawSourceCanvas ?? canvas) : baseSpec;
    if (sourceSpec) {
      const stabilized = stabilizeBlockSpec(sourceSpec, canvas, parsedInput.data.prompt);
      // Say why the model answers were not used (timeout, parse error, schema, quality gate). This
      // must go in before rendering: the plan's summary is copied from the spec at render time, so
      // appending it afterwards never reached the plugin (Tests #6/#7: no "Model attempts:" line).
      const reasons = [...new Set(errors.map((entry) => entry.replace(/\s+/g, " ").slice(0, 150)))].slice(0, 3);
      const why = reasons.length ? reasons.join(" | ") : "no model call finished (generation time budget used up before any attempt ran)";
      stabilized.spec.summary = (String(stabilized.spec.summary || "") + " Model attempts: " + why).slice(0, 690);
      const candidate = renderCandidate(stabilized.spec);
      // The fallback is the source's own content, so a subjective quality finding must not block it.
      if (candidate.plan && (candidate.stage === "ok" || candidate.stage === "quality")) {
        attemptLog.push({ model: "source-fallback", result: "passed" });
        return respond({ candidate, spec: stabilized.spec, learningCandidate: null, servedModel: "source-fallback",
          isRecovery: true, finishReason: "fallback", modelIndex: models.length - 1, themeLocked: stabilized.themeLocked,
          repairedTexts: 0, sourceFallback: true });
      }
      errors.push("source-fallback: " + candidate.error);
    }
  }
  deferTaskWork(recordGeneration(taskRunId, { model: lastServedModel || models[0] || "unknown", planFormat: "none", designScope: exampleScope,
    attempts: errors.map((entry) => ({ model: entry.split(":")[0] || "unknown", result: entry })) }, null));
  deferTaskWork(finishTaskRun({ id: taskRunId, outcome: "failed", durationMs: Date.now() - requestStartedAt,
    retrieval: taskRetrieval, errorSummary: errors[0] || "Plan generation failed." }));
  return NextResponse.json({
    error: "UX Direct could not produce a valid native Figma design plan. No canvas changes were made.",
    attemptedModels: models,
    details: errors.slice(0, 6),
  }, { status: 502, headers });
}

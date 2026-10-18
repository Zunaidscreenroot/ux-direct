import { z } from "zod";

/**
 * Provider-neutral Design IR. Models propose intent; the Figma adapter remains
 * responsible for mapping this representation to allow-listed native operations.
 */
const nonEmpty = z.string().trim().min(1).max(500);
const tokenValue = z.string().trim().min(1).max(120);

export const DesignTokenSchema = z.object({
  color: z.record(z.string(), tokenValue).default({}),
  spacing: z.record(z.string(), z.number().finite().min(0).max(2048)).default({}),
  radius: z.record(z.string(), z.number().finite().min(0).max(512)).default({}),
  typography: z.record(z.string(), z.object({
    family: tokenValue.optional(),
    size: z.number().finite().min(6).max(200).optional(),
    weight: z.number().int().min(100).max(900).optional(),
    lineHeight: z.number().finite().min(0.5).max(4).optional(),
  })).default({}),
});

export const DesignNodeSchema: z.ZodType<DesignNode> = z.lazy(() => z.object({
  id: z.string().trim().min(1).max(120),
  type: z.enum(["screen", "frame", "text", "component", "instance", "rectangle", "image", "group"]),
  name: nonEmpty,
  description: z.string().max(2000).optional(),
  layout: z.object({
    x: z.number().finite().min(-100000).max(100000).optional(),
    y: z.number().finite().min(-100000).max(100000).optional(),
    width: z.number().finite().positive().max(100000).optional(),
    height: z.number().finite().positive().max(100000).optional(),
    direction: z.enum(["horizontal", "vertical"]).optional(),
    gap: z.number().finite().min(0).max(2048).optional(),
    padding: z.number().finite().min(0).max(2048).optional(),
    align: z.enum(["start", "center", "end", "stretch"]).optional(),
  }).default({}),
  content: z.string().max(10000).optional(),
  tokenRefs: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
  children: z.array(DesignNodeSchema).max(500).default([]),
}));

export type DesignNode = {
  id: string;
  type: "screen" | "frame" | "text" | "component" | "instance" | "rectangle" | "image" | "group";
  name: string;
  description?: string;
  layout?: {
    x?: number; y?: number; width?: number; height?: number;
    direction?: "horizontal" | "vertical"; gap?: number; padding?: number;
    align?: "start" | "center" | "end" | "stretch";
  };
  content?: string;
  tokenRefs?: string[];
  children?: DesignNode[];
};

export const DesignIRSchema = z.object({
  version: z.literal("1.0"),
  project: z.enum(["general", "express-computers", "dmi-finance"]),
  title: nonEmpty,
  rationale: z.array(z.string().trim().min(1).max(1000)).max(30).default([]),
  requirements: z.array(z.object({
    id: z.string().trim().min(1).max(120),
    description: nonEmpty,
    nodeIds: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
    status: z.enum(["covered", "partial", "open"]).default("open"),
  })).max(200).default([]),
  tokens: DesignTokenSchema.default(() => ({ color: {}, spacing: {}, radius: {}, typography: {} })),
  screens: z.array(DesignNodeSchema).min(1).max(100),
}).superRefine((ir, ctx) => {
  const ids = new Set<string>();
  const tokenNames = new Set([
    ...Object.keys(ir.tokens.color),
    ...Object.keys(ir.tokens.spacing),
    ...Object.keys(ir.tokens.radius),
    ...Object.keys(ir.tokens.typography),
  ]);
  const walk = (node: DesignNode, path: string) => {
    if (ids.has(node.id)) {
      ctx.addIssue({ code: "custom", path: [...path.split(".")], message: `Duplicate design node id: ${node.id}` });
    }
    ids.add(node.id);
    for (const ref of node.tokenRefs ?? []) {
      if (!tokenNames.has(ref)) ctx.addIssue({ code: "custom", message: `Unknown design token "${ref}" referenced by node "${node.id}".` });
    }
    (node.children ?? []).forEach((child, index) => walk(child, `${path}.children.${index}`));
  };
  ir.screens.forEach((screen, index) => walk(screen, `screens.${index}`));
  for (const requirement of ir.requirements) {
    for (const nodeId of requirement.nodeIds) {
      if (!ids.has(nodeId)) ctx.addIssue({ code: "custom", message: `Requirement "${requirement.id}" references missing node "${nodeId}".` });
    }
  }
});

export type DesignIR = z.infer<typeof DesignIRSchema>;

export function validateDesignIR(input: unknown) {
  const result = DesignIRSchema.safeParse(input);
  if (!result.success) {
    return { success: false as const, issues: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })) };
  }
  return { success: true as const, data: result.data };
}

/** Stable, intentionally small summary suitable for audit/benchmark records. */
export function summarizeDesignIR(ir: DesignIR) {
  let nodeCount = 0;
  const types: Record<string, number> = {};
  const walk = (node: DesignNode) => {
    nodeCount += 1;
    types[node.type] = (types[node.type] ?? 0) + 1;
    (node.children ?? []).forEach(walk);
  };
  ir.screens.forEach(walk);
  return {
    version: ir.version,
    project: ir.project,
    title: ir.title,
    screenCount: ir.screens.length,
    nodeCount,
    nodeTypes: types,
    requirementCount: ir.requirements.length,
    uncoveredRequirements: ir.requirements.filter((item) => item.status !== "covered").map((item) => item.id),
  };
}

/**
 * Canonical native Figma canvas command catalogue.
 *
 * Keep operation IDs and their execution policy here. MCP discovery, server-side
 * validation and plugin-bridge validation derive their operation lists from this
 * catalogue so the agent cannot see a command that the executor silently rejects.
 *
 * This is policy metadata, not a substitute for runtime validation in the bridge
 * and native plugin. Every write still requires explicit confirmation and the
 * executor must independently enforce file scope, target scope and API support.
 */
export const FIGMA_CANVAS_COMMANDS = [
  { id: "batch", label: "Run ordered batch", summary: "Run a validated sequence of native canvas actions.", risk: "high", destructive: false, batchable: false, requiresExplicitIntent: true },
  { id: "create-elements", label: "Create elements", summary: "Create a bounded set of native frames, shapes, text or vectors.", risk: "medium", destructive: false, batchable: true, requiresExplicitIntent: false },
  { id: "update-node", label: "Update node", summary: "Update supported properties on one existing node.", risk: "medium", destructive: false, batchable: true, requiresExplicitIntent: false },
  { id: "clone-node", label: "Clone node", summary: "Duplicate one existing node.", risk: "medium", destructive: false, batchable: true, requiresExplicitIntent: false },
  { id: "delete-node", label: "Delete node", summary: "Delete one explicitly identified node on the current page.", risk: "high", destructive: true, batchable: false, requiresExplicitIntent: true },
  { id: "reorder-node", label: "Reorder node", summary: "Change one node's position in its parent's order.", risk: "medium", destructive: false, batchable: true, requiresExplicitIntent: false },
  { id: "reparent-node", label: "Reparent node", summary: "Move one node into a different parent on the current page.", risk: "high", destructive: true, batchable: false, requiresExplicitIntent: true },
  { id: "group-nodes", label: "Group nodes", summary: "Group an explicit set of two or more nodes.", risk: "medium", destructive: false, batchable: true, requiresExplicitIntent: false },
  { id: "flatten-nodes", label: "Flatten nodes", summary: "Flatten selected explicit nodes into flattened artwork.", risk: "high", destructive: true, batchable: false, requiresExplicitIntent: true },
  { id: "boolean-operation", label: "Boolean operation", summary: "Apply a boolean operation to explicit node IDs.", risk: "high", destructive: true, batchable: false, requiresExplicitIntent: true },
  { id: "ungroup-node", label: "Ungroup node", summary: "Ungroup one explicitly identified group.", risk: "medium", destructive: true, batchable: false, requiresExplicitIntent: true },
  { id: "create-component", label: "Create component", summary: "Convert a supported node into a component.", risk: "medium", destructive: false, batchable: true, requiresExplicitIntent: false },
  { id: "create-component-set", label: "Create component set", summary: "Combine compatible components into a variants set.", risk: "high", destructive: true, batchable: false, requiresExplicitIntent: true },
  { id: "create-instance", label: "Create instance", summary: "Create an instance from an explicit component.", risk: "medium", destructive: false, batchable: true, requiresExplicitIntent: false },
  { id: "swap-component", label: "Swap component", summary: "Replace an instance's component with a specified component.", risk: "high", destructive: true, batchable: false, requiresExplicitIntent: true },
  { id: "detach-instance", label: "Detach instance", summary: "Detach an instance from its component.", risk: "high", destructive: true, batchable: false, requiresExplicitIntent: true },
  { id: "set-selection", label: "Set selection", summary: "Change the active selection to explicit node IDs.", risk: "low", destructive: false, batchable: true, requiresExplicitIntent: false },
  { id: "zoom-to-nodes", label: "Zoom to nodes", summary: "Adjust the viewport to show explicit nodes.", risk: "low", destructive: false, batchable: true, requiresExplicitIntent: false },
  { id: "create-page", label: "Create page", summary: "Create a named page in the allowlisted file.", risk: "medium", destructive: false, batchable: true, requiresExplicitIntent: false },
  { id: "rename-page", label: "Rename page", summary: "Rename an explicit page in the allowlisted file.", risk: "medium", destructive: false, batchable: true, requiresExplicitIntent: false },
  { id: "set-current-page", label: "Set current page", summary: "Switch to an explicit page in the allowlisted file.", risk: "low", destructive: false, batchable: true, requiresExplicitIntent: false },
  { id: "export-svg", label: "Export SVG", summary: "Export one node to SVG.", risk: "low", destructive: false, batchable: false, requiresExplicitIntent: false },
  { id: "export-node", label: "Export node", summary: "Export one node to a supported image or document format.", risk: "low", destructive: false, batchable: false, requiresExplicitIntent: false },
  { id: "apply-style", label: "Apply style", summary: "Apply a specified local style to one node.", risk: "medium", destructive: false, batchable: true, requiresExplicitIntent: false },
  { id: "set-text-range", label: "Set text range", summary: "Update supported formatting within an explicit text range.", risk: "medium", destructive: false, batchable: true, requiresExplicitIntent: false },
  { id: "create-image-fill", label: "Create image fill", summary: "Apply supplied image data as a fill on one node.", risk: "medium", destructive: false, batchable: false, requiresExplicitIntent: false },
  { id: "insert-image", label: "Insert image", summary: "Insert supplied image data as a native image layer.", risk: "medium", destructive: false, batchable: false, requiresExplicitIntent: false },
  { id: "create-variables", label: "Create variables", summary: "Create named local variables in a specified collection.", risk: "medium", destructive: false, batchable: true, requiresExplicitIntent: false },
  { id: "bind-variable", label: "Bind variable", summary: "Bind a specified local variable to a supported node property.", risk: "medium", destructive: false, batchable: true, requiresExplicitIntent: false },
] as const;

export type FigmaCanvasOperation = (typeof FIGMA_CANVAS_COMMANDS)[number]["id"];
export type FigmaCanvasCommand = (typeof FIGMA_CANVAS_COMMANDS)[number];
export type FigmaCanvasRisk = FigmaCanvasCommand["risk"];

export const FIGMA_CANVAS_OPERATION_IDS = FIGMA_CANVAS_COMMANDS.map(({ id }) => id) as [
  FigmaCanvasOperation,
  ...FigmaCanvasOperation[],
];

export const FIGMA_CANVAS_STEP_OPERATION_IDS = FIGMA_CANVAS_COMMANDS
  .filter(({ id }) => id !== "batch")
  .map(({ id }) => id) as [
    Exclude<FigmaCanvasOperation, "batch">,
    ...Exclude<FigmaCanvasOperation, "batch">[],
  ];

/** Operations whose payloads must be sent alone rather than inside a multi-step batch. */
export const FIGMA_CANVAS_NON_BATCHABLE_STEP_OPERATIONS = FIGMA_CANVAS_COMMANDS
  .filter(({ id, batchable }) => id !== "batch" && !batchable)
  .map(({ id }) => id) as Exclude<FigmaCanvasOperation, "batch">[];

/** Shared, client-safe metadata for command discovery and review UIs. */
export const FIGMA_CANVAS_COMMAND_POLICY: Record<FigmaCanvasOperation, FigmaCanvasCommand> =
  Object.fromEntries(FIGMA_CANVAS_COMMANDS.map((command) => [command.id, command])) as Record<FigmaCanvasOperation, FigmaCanvasCommand>;

export function isFigmaCanvasOperation(value: unknown): value is FigmaCanvasOperation {
  return typeof value === "string" && FIGMA_CANVAS_COMMANDS.some((command) => command.id === value);
}

/** Runtime predicate shared by validators that accept untrusted JSON. */
export function isFigmaCanvasNonBatchableStepOperation(value: unknown): boolean {
  return typeof value === "string" &&
    FIGMA_CANVAS_NON_BATCHABLE_STEP_OPERATIONS.some((operation) => operation === value);
}

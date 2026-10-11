import { z } from "zod";
import { assertFigmaFileAccess, parseAllowedFileIds } from "../security/figma-access";

const figmaNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.string(),
  children: z.array(z.unknown()).optional(),
  characters: z.string().optional(),
  absoluteBoundingBox: z.object({
    x: z.number(), y: z.number(), width: z.number(), height: z.number(),
  }).optional(),
  componentId: z.string().optional(),
  styles: z.record(z.string(), z.string()).optional(),
}).passthrough();

const figmaFileResponseSchema = z.object({
  document: z.unknown(),
  components: z.record(z.string(), z.unknown()).optional(),
  componentSets: z.record(z.string(), z.unknown()).optional(),
  styles: z.record(z.string(), z.unknown()).optional(),
});

export type FigmaReadConfig = {
  accessToken: string;
  allowedFileIdsRaw?: string;
  workspaceLabel: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
};

export type FigmaReadResult = {
  fileId: string;
  workspaceLabel: string;
  version?: string;
  document: unknown;
  components: Record<string, unknown>;
  componentSets: Record<string, unknown>;
  styles: Record<string, unknown>;
  readOnly: true;
};

export class FigmaReadAdapter {
  constructor(private readonly config: FigmaReadConfig) {}

  async readFile(fileId: string): Promise<FigmaReadResult> {
    const allowedFileIds = parseAllowedFileIds(this.config.allowedFileIdsRaw);
    assertFigmaFileAccess(fileId, this.config.workspaceLabel, { allowedFileIds });
    if (!this.config.accessToken.trim()) throw new Error("Figma read blocked: access token is not configured.");

    const fetchImpl = this.config.fetchImpl ?? fetch;
    const base = (this.config.apiBaseUrl ?? "https://api.figma.com/v1").replace(/\/$/, "");
    const response = await fetchImpl(`${base}/files/${encodeURIComponent(fileId)}?depth=4`, {
      method: "GET",
      headers: { "X-Figma-Token": this.config.accessToken, Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Figma read failed with HTTP ${response.status}; response body intentionally omitted.`);
    }
    const parsed = figmaFileResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Figma read failed: response did not match the expected file schema.");

    return {
      fileId,
      workspaceLabel: this.config.workspaceLabel,
      document: parsed.data.document,
      components: parsed.data.components ?? {},
      componentSets: parsed.data.componentSets ?? {},
      styles: parsed.data.styles ?? {},
      readOnly: true,
    };
  }
}

export function summarizeFigmaNode(input: unknown): {
  id: string; name: string; type: string; text?: string; bounds?: { x: number; y: number; width: number; height: number }; childCount: number;
} {
  const parsed = figmaNodeSchema.parse(input);
  return {
    id: parsed.id,
    name: parsed.name,
    type: parsed.type,
    ...(parsed.characters === undefined ? {} : { text: parsed.characters }),
    ...(parsed.absoluteBoundingBox === undefined ? {} : { bounds: parsed.absoluteBoundingBox }),
    childCount: parsed.children?.length ?? 0,
  };
}

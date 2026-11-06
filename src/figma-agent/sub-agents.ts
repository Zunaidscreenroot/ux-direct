/**
 * Parallel sub-agents for the Figma design pipeline.
 *
 *   ┌ Context detector  (domain, product, screen type, user goal)  ┐
 *   ├ UX analyst        (primary action, hierarchy, problems)      ├─► Brief composer ─► Planner (strongest `auto` call)
 *   └ Component scout   (which file components fit which control)  ┘   (deterministic, grounded)
 *
 * The three agents call FreeLLMAPI `auto` at the same time, alongside brain retrieval, so the
 * extra wall time is the slowest agent, not the sum. The composer is deterministic: it keeps only
 * text that exists in the source, only component IDs that exist in the file, and caps every list,
 * so an agent that hallucinates cannot push invented content into the plan. Any agent can fail or
 * time out; the planner then runs with the deterministic role/domain detection alone.
 */
import { callFigmaJsonModel, type JsonModelContent } from "@/src/figma-agent/json-model-call";
import { detectDomain, domainById, roleInstructions, type DomainProfile, type TaskRole } from "@/src/figma-agent/agent-roles";

type Rec = Record<string, unknown>;

export interface SubAgentInput {
  prompt: string;
  role: TaskRole;
  designScope: string;
  selectedNode: { name: string; type: string; width: number; height: number };
  sourceTexts: string[];
  components: Array<Record<string, unknown>>;
  renderedScreen: string | null;
  origin: string;
}

export interface SubAgentRun {
  agent: "detector" | "analyst" | "scout";
  ok: boolean;
  ms: number;
  model?: string;
  error?: string;
}

export interface AgentBrief {
  domain: DomainProfile;
  domainSource: "agent" | "keywords" | "default";
  /** Prompt text for the planner; empty when nothing useful was produced. */
  instructions: string;
  runs: SubAgentRun[];
}

export function subAgentsEnabled(): boolean {
  return (process.env.UXD_SUB_AGENTS || "on").trim().toLowerCase() !== "off";
}

function subAgentTimeoutMs(): number {
  const value = Number(process.env.UXD_SUB_AGENT_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 5000 ? value : 45000;
}

const AGENT_RULES = "You are one sub-agent in a team; another model will design the screen from your notes. Report only what the request, the source text list and the screenshot show. If something is unclear, say \"unknown\" rather than guessing. Return one JSON object only, no markdown.";

function str(value: unknown, max = 160): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function strList(value: unknown, limit: number, max = 160): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => str(typeof item === "object" && item ? (item as Rec).text ?? (item as Rec).item ?? (item as Rec).label : item, max))
    .filter(Boolean).slice(0, limit);
}

const norm = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}₹%.]+/gu, " ").trim();

/** Keep only items whose text appears in the source; agents may not add content. */
export function groundedInSource(items: string[], sourceTexts: string[]): string[] {
  const corpus = sourceTexts.map(norm).filter(Boolean);
  const kept: string[] = [];
  for (const item of items) {
    const key = norm(item);
    if (key.length < 2) continue;
    if (corpus.some((text) => text === key || (key.length >= 4 && (text.includes(key) || key.includes(text) && text.length >= 4)))) {
      if (!kept.some((existing) => norm(existing) === key)) kept.push(item);
    }
  }
  return kept;
}

function userContent(text: string, renderedScreen: string | null): JsonModelContent {
  return renderedScreen
    ? [{ type: "text", text }, { type: "image_url", image_url: { url: renderedScreen } }]
    : text;
}

function sharedContext(input: SubAgentInput, extra: Rec = {}): string {
  return JSON.stringify({
    userRequest: input.prompt,
    designScope: input.designScope,
    selectedNode: input.selectedNode,
    sourceTexts: input.sourceTexts.slice(0, 80),
    screenshot: input.renderedScreen ? "attached" : "not available",
    ...extra,
  });
}

async function runAgent(
  agent: SubAgentRun["agent"],
  input: SubAgentInput,
  system: string,
  user: string,
  accept: (data: Rec) => string | null,
): Promise<{ run: SubAgentRun; data: Rec | null }> {
  const started = Date.now();
  try {
    const result = await callFigmaJsonModel({
      system: AGENT_RULES + "\n" + system,
      user: userContent(user, input.renderedScreen),
      hasVisionInput: Boolean(input.renderedScreen),
      maxTokens: 1800,
      temperature: 0.1,
      title: "UX Direct sub-agent: " + agent,
      origin: input.origin,
      timeoutMs: subAgentTimeoutMs(),
      anyObject: true,
      accept,
    });
    if (!result.ok) return { run: { agent, ok: false, ms: Date.now() - started, error: (result.errors[0] || result.error).slice(0, 200) }, data: null };
    return { run: { agent, ok: true, ms: Date.now() - started, model: result.model }, data: result.data };
  } catch (error) {
    return { run: { agent, ok: false, ms: Date.now() - started, error: String(error instanceof Error ? error.message : error).slice(0, 200) }, data: null };
  }
}

const DETECTOR_SYSTEM = [
  "ROLE: Context detector. Identify what this product and screen are, from evidence only.",
  "Return {domain, product, screenType, userGoal, audience, keyContent}. domain is one of fintech, insurance, healthcare, ecommerce, edtech, travel, food, saas, social, general.",
  "product: what the product is in under 12 words. screenType: e.g. loan summary, checkout, settings. userGoal: what the user comes to this screen to do. keyContent: up to 8 source text items that matter most, copied exactly from sourceTexts.",
].join("\n");

const ANALYST_SYSTEM = [
  "ROLE: UX analyst. Read the screen like a senior product designer before anyone redesigns it.",
  "Return {primaryAction, hierarchy, problems, changes, avoid}.",
  "primaryAction: the one main action, copied exactly from sourceTexts, or \"unknown\".",
  "hierarchy: up to 6 content groups in the order a user needs them, each a short name plus the source texts it holds, e.g. \"Outstanding amount: ₹45,000 · Due 5 Jan\".",
  "problems: up to 5 concrete, visible UX problems (hierarchy, grouping, spacing, contrast, action priority). No generic advice.",
  "changes: up to 5 specific changes that do what the user asked, in the role given. Never add features, data or sections the source does not have.",
  "avoid: up to 4 things a careless redesign of this screen would get wrong.",
].join("\n");

const SCOUT_SYSTEM = [
  "ROLE: Design-system scout. Match the screen's controls to the file's existing components.",
  "Return {matches:[{control, componentId, reason}]}: up to 8 entries. control is a control on this screen (button, tab, input, list row, chip, nav bar...). componentId must be copied exactly from the components list. Skip a control when no listed component fits.",
].join("\n");

/** Runs the three sub-agents in parallel and composes a grounded brief for the planner. */
export async function runSubAgents(input: SubAgentInput): Promise<AgentBrief> {
  const keywordDomain = detectDomain(input.prompt, input.sourceTexts);
  const componentList = input.components.slice(0, 40).map((component) => ({
    id: component.id, name: component.name, ...(component.properties ? { properties: component.properties } : {}),
  }));
  const componentIds = new Set(componentList.map((component) => component.id).filter((id): id is string => typeof id === "string"));
  const roleNote = { role: input.role.label, roleFocus: input.role.persona, keywordDomainHint: keywordDomain.domain.id };

  const [detector, analyst, scout] = await Promise.all([
    runAgent("detector", input, DETECTOR_SYSTEM, sharedContext(input, { keywordDomainHint: keywordDomain.domain.id }),
      (data) => (str(data.domain) || str(data.userGoal) ? null : "missing domain and userGoal")),
    runAgent("analyst", input, ANALYST_SYSTEM, sharedContext(input, roleNote),
      (data) => (Array.isArray(data.hierarchy) || Array.isArray(data.changes) ? null : "missing hierarchy and changes")),
    componentIds.size
      ? runAgent("scout", input, SCOUT_SYSTEM, sharedContext(input, { components: componentList }),
        (data) => (Array.isArray(data.matches) ? null : "missing matches"))
      : Promise.resolve(null),
  ]);

  return composeBrief(input, keywordDomain, detector, analyst, scout, componentIds);
}

type AgentResult = { run: SubAgentRun; data: Rec | null } | null;

/** Deterministic, grounded merge of the agents' notes. Exported for tests. */
export function composeBrief(
  input: Pick<SubAgentInput, "role" | "sourceTexts">,
  keywordDomain: ReturnType<typeof detectDomain>,
  detector: AgentResult,
  analyst: AgentResult,
  scout: AgentResult,
  componentIds: Set<string>,
): AgentBrief {
  const runs = [detector, analyst, scout].filter((item): item is NonNullable<AgentResult> => Boolean(item)).map((item) => item.run);
  const d = detector?.data ?? null;
  const a = analyst?.data ?? null;
  const s = scout?.data ?? null;

  // The agent's domain wins only when it names a known domain; strong keyword evidence
  // (5+ hits) still beats an agent that says "general".
  const agentDomain = d ? domainById(str(d.domain, 40)) : null;
  const useAgent = agentDomain && !(agentDomain.id === "general" && keywordDomain.score >= 5);
  const domain = useAgent ? agentDomain : keywordDomain.domain;
  const domainSource: AgentBrief["domainSource"] = useAgent ? "agent" : keywordDomain.score ? "keywords" : "default";

  const lines: string[] = [roleInstructions(input.role, domain)];
  const notes: string[] = [];
  if (d) {
    const product = str(d.product, 120);
    const screenType = str(d.screenType, 80);
    const userGoal = str(d.userGoal, 160);
    if (product && !/^unknown$/i.test(product)) notes.push("Product: " + product);
    if (screenType && !/^unknown$/i.test(screenType)) notes.push("Screen: " + screenType);
    if (userGoal && !/^unknown$/i.test(userGoal)) notes.push("User goal: " + userGoal);
    const keyContent = groundedInSource(strList(d.keyContent, 8), input.sourceTexts);
    if (keyContent.length) notes.push("Most important source content: " + keyContent.join(" | "));
  }
  if (a) {
    const primary = groundedInSource([str(a.primaryAction, 80)].filter(Boolean), input.sourceTexts);
    if (primary.length) notes.push("Primary action (from source): " + primary[0]);
    const hierarchy = strList(a.hierarchy, 6, 200);
    if (hierarchy.length) notes.push("Content order users need: " + hierarchy.map((item, index) => (index + 1) + ". " + item).join(" "));
    const problems = strList(a.problems, 5);
    if (problems.length) notes.push("Problems to fix: " + problems.join("; "));
    const changes = strList(a.changes, 5);
    if (changes.length) notes.push("Planned changes: " + changes.join("; "));
    const avoid = strList(a.avoid, 4);
    if (avoid.length) notes.push("Avoid: " + avoid.join("; "));
  }
  if (s && Array.isArray(s.matches)) {
    const matches = (s.matches as unknown[]).flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Rec;
      const id = str(record.componentId, 80);
      const control = str(record.control, 60);
      return id && control && componentIds.has(id) ? [control + " → " + id] : [];
    }).slice(0, 8);
    if (matches.length) notes.push("File components to reuse: " + matches.join("; "));
  }
  if (notes.length) {
    lines.push(
      "SUB-AGENT BRIEF (from UX Direct's detector, UX analyst and component scout; grounded against the source). Use it to plan; the source layers and the user's request still win if anything here disagrees:",
      ...notes.map((note) => "- " + note),
    );
  }
  return { domain, domainSource, instructions: lines.join("\n"), runs };
}

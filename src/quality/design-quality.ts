import { z } from "zod";
import type { TaskProject } from "../core/types";
import { ProjectMemory, type ProjectMemoryEntry } from "../memory/project-memory";

const designInstructionSchema = z.object({
  project: z.enum(["general", "express-computers", "dmi-finance"]),
  taskTitle: z.string().min(1),
  goal: z.string().min(1),
  userJourney: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    purpose: z.string().min(1),
    entryConditions: z.array(z.string()),
    actions: z.array(z.string()),
    states: z.array(z.enum(["default", "loading", "empty", "error", "retry", "success", "cancelled", "blocked"])),
    exitCriteria: z.array(z.string()),
  })).min(1),
  requirements: z.array(z.object({ id: z.string(), description: z.string(), evidence: z.string(), status: z.enum(["covered", "assumption", "open"]) })),
  designPrinciples: z.array(z.string()),
  components: z.array(z.object({ name: z.string(), purpose: z.string(), reuseEvidence: z.string().optional() })),
  qualityChecks: z.array(z.string()),
  unresolvedQuestions: z.array(z.string()),
  humanReviewRequired: z.literal(true),
});

export type DesignInstruction = z.infer<typeof designInstructionSchema>;

export type QualityFinding = {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  category: "requirements" | "states" | "accessibility" | "provenance" | "security" | "handoff";
  message: string;
  resolution: string;
};

export type QualityReport = {
  passed: boolean;
  score: number;
  findings: QualityFinding[];
  checkedAt: string;
  iteration: number;
  maxIterations: number;
};

export function validateDesignInstruction(input: unknown): DesignInstruction {
  return designInstructionSchema.parse(input);
}

export function critiqueDesignInstruction(input: unknown, memory?: ProjectMemory, iteration = 1): QualityReport {
  const parsed = designInstructionSchema.safeParse(input);
  const findings: QualityFinding[] = [];
  const add = (id: string, severity: QualityFinding["severity"], category: QualityFinding["category"], message: string, resolution: string) =>
    findings.push({ id, severity, category, message, resolution });

  if (!parsed.success) {
    add("schema-invalid", "critical", "handoff", "Design instruction does not match the required structured contract.", "Fix schema errors before handing instructions to a design executor.");
    return { passed: false, score: 0, findings, checkedAt: new Date().toISOString(), iteration: Math.max(1, iteration), maxIterations: 3 };
  }

  const plan = parsed.data;
  if (plan.requirements.length === 0) add("no-requirements", "high", "requirements", "No requirements are mapped.", "Map each brief requirement to evidence, a design decision, or an explicit open item.");
  if (plan.requirements.some((requirement) => requirement.status === "open")) {
    add("open-requirements", "high", "requirements", "One or more requirements remain unresolved.", "Resolve or visibly flag every open requirement before final approval.");
  }
  if (plan.requirements.some((requirement) => requirement.status === "assumption")) {
    add("assumptions", "medium", "requirements", "Some design requirements depend on assumptions.", "Mark assumptions and request product-owner confirmation.");
  }
  if (!plan.userJourney.some((step) => step.states.includes("error"))) {
    add("missing-error-state", "high", "states", "No error state is represented in the journey.", "Define recovery and next steps for failures.");
  }
  if (!plan.userJourney.some((step) => step.states.includes("loading"))) {
    add("missing-loading-state", "medium", "states", "No loading state is represented.", "Specify the pending state and prevent ambiguous repeated submissions.");
  }
  if (!plan.designPrinciples.some((principle) => /accessib|keyboard|contrast|screen reader|wcag/i.test(principle))) {
    add("accessibility-not-explicit", "medium", "accessibility", "Accessibility is not explicit in the design principles.", "Include keyboard, focus, contrast and assistive-technology checks relevant to the surface.");
  }
  if (plan.components.some((component) => !component.reuseEvidence) && plan.project !== "general") {
    add("component-provenance", "medium", "provenance", "At least one project component lacks reuse evidence.", "Link the existing component or mark it as a proposed new component rather than claiming reuse.");
  }
  if (plan.project === "dmi-finance" && !plan.designPrinciples.some((principle) => /consent|privacy|purpose limitation/i.test(principle))) {
    add("financial-consent", "high", "security", "Financial journey does not explicitly state consent/privacy principles.", "Specify purpose-limited consent and do not imply identity or bureau checks succeeded without evidence.");
  }
  if (plan.project === "express-computers" && !plan.designPrinciples.some((principle) => /batch 1|batch 2|review feedback|approved pattern/i.test(principle))) {
    add("express-pattern-evidence", "high", "provenance", "Express workflow does not reference approved prior-batch patterns or feedback.", "Attach Batch 1/2 evidence and reviewer feedback before calling the screens consistent.");
  }
  if (memory && memory.list(plan.project as TaskProject).length === 0 && plan.project !== "general") {
    add("memory-empty", "medium", "provenance", "No saved project memory exists for this project.", "Gather approved source screens and feedback before treating conventions as established facts.");
  }
  const critical = findings.some((finding) => finding.severity === "critical");
  const highCount = findings.filter((finding) => finding.severity === "high").length;
  const score = Math.max(0, 100 - findings.reduce((sum, finding) => sum + ({ critical: 100, high: 18, medium: 8, low: 3 }[finding.severity]), 0));
  return {
    passed: !critical && highCount === 0,
    score,
    findings,
    checkedAt: new Date().toISOString(),
    iteration: Math.max(1, Math.min(iteration, 3)),
    maxIterations: 3,
  };
}

export function nextBoundedIteration(report: QualityReport): number | null {
  if (report.passed || report.iteration >= report.maxIterations) return null;
  return report.iteration + 1;
}

export function saveVerifiedMemory(memory: ProjectMemory, entry: ProjectMemoryEntry): void {
  if (!entry.verified) throw new Error("Only verified evidence may be saved through saveVerifiedMemory.");
  memory.add(entry);
}

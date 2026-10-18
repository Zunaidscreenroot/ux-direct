export type TaskProject = "general" | "express-computers" | "dmi-finance";

export type TaskStatus =
  | "queued"
  | "planning"
  | "running"
  | "validating"
  | "needs_review"
  | "completed"
  | "failed";

export type CapabilityRisk = "low" | "medium" | "high";
export type CapabilityCostClass = "free-local" | "paid-model" | "external-read" | "external-write";

export type CapabilityDefinition = {
  id: string;
  description: string;
  risk: CapabilityRisk;
  costClass: CapabilityCostClass;
  requiresApproval: boolean;
  run(input: Record<string, unknown>): Promise<Record<string, unknown>>;
};

export type UXTask = {
  id: string;
  title: string;
  request: string;
  project: TaskProject;
  status: TaskStatus;
  createdAt: string;
  steps: TaskStep[];
  notes: string[];
};

export type TaskStep = {
  id: string;
  label: string;
  status: "pending" | "running" | "passed" | "failed" | "blocked";
  detail?: string;
};

export type BrainLearningCandidate = {
  title: string;
  normalizedRule: string;
  rationale: string;
  scopeKey: string;
  feedbackKind: string;
  keywords: string[];
  examples: unknown[];
  originalLanguage: string;
  activate: boolean;
};

export type TaskPlan = {
  summary: string;
  assumptions: string[];
  steps: Array<{ id: string; label: string; capabilityId: string }>;
  qualityChecks: string[];
  requiresHumanReview: boolean;
  learningCandidate?: BrainLearningCandidate | null;
};

export type ModelProvider = {
  id: string;
  mode: "mock" | "local" | "remote";
  plan(request: { title: string; request: string; project: TaskProject; requestId?: string; memoryContext?: string; learningRequested?: boolean }): Promise<TaskPlan>;
};

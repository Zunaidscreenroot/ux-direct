import { z } from "zod";
import type { TaskProject } from "../core/types";

export const ExpertFeedbackSchema = z.object({
  taskId: z.string().trim().min(1).max(120),
  project: z.enum(["general", "express-computers", "dmi-finance"]),
  issueCategory: z.enum(["requirements", "visual-hierarchy", "layout", "design-system", "content", "accessibility", "interaction", "responsive", "technical", "other"]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  evidence: z.string().trim().min(1).max(2000),
  expectedOutcome: z.string().trim().min(1).max(2000),
  recommendation: z.string().trim().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  accepted: z.boolean(),
  reviewer: z.enum(["human", "expert-model", "automated-check"]),
  rubric: z.object({
    requirementCoverage: z.number().int().min(1).max(5),
    visualQuality: z.number().int().min(1).max(5),
    consistency: z.number().int().min(1).max(5),
    accessibility: z.number().int().min(1).max(5),
    implementationValidity: z.number().int().min(1).max(5),
  }),
  createdAt: z.string().datetime(),
});

export type ExpertFeedback = z.infer<typeof ExpertFeedbackSchema>;
export type FeedbackCandidate = {
  id: string;
  project: TaskProject;
  title: string;
  detail: string;
  source: string;
  tags: string[];
  verified: boolean;
  createdAt: string;
};

/**
 * Model critique is evidence, not truth. Only explicit human review can promote
 * feedback to trusted project memory; model-only feedback stays a draft.
 */
export function feedbackToMemoryCandidate(feedbackInput: unknown, id: string): FeedbackCandidate {
  const feedback = ExpertFeedbackSchema.parse(feedbackInput);
  const approved = feedback.reviewer === "human" && feedback.accepted && feedback.confidence >= 0.7;
  return {
    id,
    project: feedback.project,
    title: `Feedback: ${feedback.issueCategory} (${feedback.severity})`,
    detail: `Expected: ${feedback.expectedOutcome} Recommendation: ${feedback.recommendation} Evidence: ${feedback.evidence}`,
    source: `task:${feedback.taskId}; reviewer:${feedback.reviewer}; accepted:${feedback.accepted}`,
    tags: ["feedback", feedback.issueCategory, feedback.severity],
    verified: approved,
    createdAt: feedback.createdAt,
  };
}

export function scoreFeedbackRubric(feedbackInput: unknown) {
  const feedback = ExpertFeedbackSchema.parse(feedbackInput);
  const values = Object.values(feedback.rubric);
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    average: Math.round(average * 100) / 100,
    passed: average >= 4 && feedback.accepted && feedback.confidence >= 0.7,
    needsHumanReview: feedback.reviewer !== "human",
  };
}

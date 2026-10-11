import { randomUUID } from "node:crypto";
import type { ModelProvider, TaskProject, UXTask } from "./types";

export async function planUXTask(input: {
  title: string;
  request: string;
  project: TaskProject;
  provider?: ModelProvider;
}): Promise<{ task: UXTask; plan: Awaited<ReturnType<ModelProvider["plan"]>> }> {
  const provider = input.provider;
  if (!provider) throw new Error("No task planner configured. Use the mock provider until a provider is approved.");
  const now = new Date().toISOString();
  const plan = await provider.plan({ title: input.title, request: input.request, project: input.project });
  const task: UXTask = {
    id: randomUUID(),
    title: input.title.trim() || "Untitled UX task",
    request: input.request,
    project: input.project,
    status: "needs_review",
    createdAt: now,
    steps: plan.steps.map((step) => ({ id: step.id, label: step.label, status: "pending" })),
    notes: ["Plan generated in provider mode: " + provider.mode, "Human review required before external writes."],
  };
  return { task, plan };
}

import type { TaskStatus } from "./types";

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["planning", "failed"],
  planning: ["running", "needs_review", "failed"],
  running: ["validating", "needs_review", "failed"],
  validating: ["running", "needs_review", "completed", "failed"],
  needs_review: ["queued", "running", "completed", "failed"],
  completed: [],
  failed: ["queued"],
};

export type TaskTransition = {
  from: TaskStatus;
  to: TaskStatus;
  at: string;
  reason: string;
  attempt: number;
};

export type TaskLifecycle = {
  status: TaskStatus;
  attempt: number;
  maxAttempts: number;
  history: TaskTransition[];
};

export function createTaskLifecycle(status: TaskStatus = "queued", maxAttempts = 3): TaskLifecycle {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("maxAttempts must be an integer between 1 and 10.");
  }
  return { status, attempt: 0, maxAttempts, history: [] };
}

export function transitionTask(
  lifecycle: TaskLifecycle,
  next: TaskStatus,
  reason: string,
  at = new Date().toISOString(),
): TaskLifecycle {
  if (!reason.trim()) throw new Error("A transition reason is required for the audit trail.");
  if (!transitions[lifecycle.status].includes(next)) {
    throw new Error(`Invalid task transition: ${lifecycle.status} -> ${next}`);
  }
  const startsAttempt = next === "running" && lifecycle.status !== "running";
  if (startsAttempt && lifecycle.attempt >= lifecycle.maxAttempts) {
    throw new Error(`Task retry limit reached (${lifecycle.maxAttempts}).`);
  }
  const attempt = lifecycle.attempt + (startsAttempt ? 1 : 0);
  return {
    status: next,
    attempt,
    maxAttempts: lifecycle.maxAttempts,
    history: [...lifecycle.history, { from: lifecycle.status, to: next, at, reason: reason.trim().slice(0, 500), attempt }],
  };
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to);
}

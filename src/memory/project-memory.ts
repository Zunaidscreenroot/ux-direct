import type { TaskProject } from "./types";

export type ProjectMemoryEntry = {
  id: string;
  project: TaskProject;
  kind: "pattern" | "feedback" | "requirement" | "decision" | "assumption";
  title: string;
  detail: string;
  source: string;
  verified: boolean;
  tags: string[];
  createdAt: string;
};

export type ProjectMemoryQuery = {
  project: TaskProject;
  query?: string;
  includeUnverified?: boolean;
  limit?: number;
};

const normalize = (value: string) => value.toLowerCase().normalize("NFKC").trim();

export class ProjectMemory {
  private readonly entries = new Map<string, ProjectMemoryEntry>();

  add(entry: ProjectMemoryEntry): void {
    if (!entry.id.trim() || !entry.title.trim() || !entry.detail.trim()) {
      throw new Error("Memory entries require an id, title, and detail.");
    }
    if (!entry.source.trim()) throw new Error("Memory entries require provenance.");
    this.entries.set(entry.id, { ...entry, tags: [...new Set(entry.tags.map(normalize))] });
  }

  get(id: string): ProjectMemoryEntry | undefined {
    const entry = this.entries.get(id);
    return entry ? { ...entry, tags: [...entry.tags] } : undefined;
  }

  list(project: TaskProject): ProjectMemoryEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.project === project)
      .map((entry) => ({ ...entry, tags: [...entry.tags] }));
  }

  search(input: ProjectMemoryQuery): ProjectMemoryEntry[] {
    const queryTerms = normalize(input.query ?? "").split(/\s+/).filter(Boolean);
    const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
    return this.list(input.project)
      .filter((entry) => input.includeUnverified || entry.verified)
      .map((entry) => {
        const haystack = normalize([entry.title, entry.detail, entry.source, ...entry.tags].join(" "));
        const score = queryTerms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
        return { entry, score };
      })
      .filter(({ score }) => queryTerms.length === 0 || score > 0)
      .sort((a, b) => Number(b.entry.verified) - Number(a.entry.verified) || b.score - a.score || a.entry.createdAt.localeCompare(b.entry.createdAt))
      .slice(0, limit)
      .map(({ entry }) => ({ ...entry, tags: [...entry.tags] }));
  }
}

export const projectMemory = new ProjectMemory();

/** Small page-at-a-time helpers so command-center lists send a few rows, not everything. */
export const LIST_PAGE_SIZE = 6;

export function pageParams(url: URL, max = 50): { offset: number; limit: number } {
  const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
  const limit = Math.max(1, Math.min(max, Math.floor(Number(url.searchParams.get("limit")) || LIST_PAGE_SIZE)));
  return { offset, limit };
}

export function slicePage<T>(items: T[], offset: number, limit: number): { items: T[]; total: number; nextOffset: number | null } {
  const page = items.slice(offset, offset + limit);
  const next = offset + page.length;
  return { items: page, total: items.length, nextOffset: next < items.length ? next : null };
}

type Filterable = { title: string; category: string; roles: string[]; domains?: string[]; tags: string[]; body: string; sources: string[] };

/** Knowledge browse filter (same rules the page used client-side). */
export function filterKnowledge<T extends Filterable>(entries: T[], filters: { search?: string | null; category?: string | null; role?: string | null; domain?: string | null }): T[] {
  const words = (filters.search || "").toLowerCase().split(/\s+/).filter(Boolean);
  const category = filters.category && filters.category !== "all" ? filters.category : "";
  const role = filters.role && filters.role !== "all" ? filters.role : "";
  const domain = filters.domain && filters.domain !== "all" ? filters.domain : "";
  return entries.filter((entry) => {
    if (category && entry.category !== category) return false;
    if (role && !entry.roles.includes("all") && !entry.roles.includes(role)) return false;
    if (domain && !(entry.domains || []).includes(domain)) return false;
    if (!words.length) return true;
    const hay = (entry.title + " " + entry.tags.join(" ") + " " + entry.body + " " + entry.sources.join(" ")).toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

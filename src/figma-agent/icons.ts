import { NextResponse } from "next/server";
import { z } from "zod";
import { isAllowedPluginOrigin, pluginCorsHeaders } from "./route-cors";

/**
 * Icons from Iconify's free public API (no key), so the plugin can add real icons, which the Figma
 * agent cannot do. Lucide is the default set: one consistent 24px stroke style, MIT licensed.
 * Picking an icon for a button or row label is deterministic, with no model involved.
 */

export const ICON_SET = "lucide";
const ICONIFY = "https://api.iconify.design";

/** Label keywords → Lucide icon name. The first match wins, so more specific entries come first. */
const LABEL_ICONS: Array<[RegExp, string]> = [
  [/\b(send money|transfer|send|remit)\b/i, "send"],
  [/\b(pay|payment|pay now|checkout|card|cards|debit|credit)\b/i, "credit-card"],
  [/\b(wallet|balance)\b/i, "wallet"],
  [/\b(status|on track|approved|verified|completed?)\b/i, "circle-check"],
  [/\b(scan|qr|upi)\b/i, "scan-line"],
  [/\b(bank|banking|account|accounts|a\/c)\b/i, "landmark"],
  [/\b(loan|loans|emi|borrow)\b/i, "hand-coins"],
  [/\b(invest|investment|mutual fund|sip|stocks?|portfolio|returns?)\b/i, "trending-up"],
  [/\b(insurance|policy|cover|protect)\b/i, "shield-check"],
  [/\b(saving|savings|deposit|fd|rd)\b/i, "piggy-bank"],
  [/\b(bill|bills|recharge|invoice|receipt)\b/i, "receipt"],
  [/\b(history|transactions?|activity|passbook)\b/i, "history"],
  [/\b(statement|download|export)\b/i, "download"],
  [/\b(upload|attach)\b/i, "upload"],
  [/\b(offers?|rewards?|cashback|gift)\b/i, "gift"],
  // Other domains (travel, health, learning, food, commerce, media, work, social), so auto icons work beyond banking.
  [/\b(flights?|boarding|airport)\b/i, "plane"],
  [/\b(hotels?|stays?|rooms?|check-?in)\b/i, "bed-double"],
  [/\b(rides?|cabs?|taxi|car|drive)\b/i, "car"],
  [/\b(tickets?|bookings?|events?)\b/i, "ticket"],
  [/\b(doctors?|clinic|health|medical|consult(ation)?)\b/i, "stethoscope"],
  [/\b(appointments?|slots?)\b/i, "calendar-clock"],
  [/\b(courses?|lessons?|classes|learn(ing)?)\b/i, "graduation-cap"],
  [/\b(books?|library|ebooks?)\b/i, "book-open"],
  [/\b(menu|food|restaurants?|meals?|dine|dining)\b/i, "utensils"],
  [/\b(orders?|packages?|parcels?)\b/i, "package"],
  [/\b(track(ing)?|shipping|delivery|deliveries)\b/i, "truck"],
  [/\b(products?|catalogu?e|store)\b/i, "store"],
  [/\b(ratings?|reviews?|stars?)\b/i, "star"],
  [/\b(play|watch|videos?)\b/i, "play"],
  [/\b(music|songs?|podcasts?|audio)\b/i, "music"],
  [/\b(photos?|gallery|images?|camera)\b/i, "camera"],
  [/\b(chat|messages?|inbox|comments?)\b/i, "message-circle"],
  [/\b(team|members|people|contacts|friends|community)\b/i, "users"],
  [/\b(tasks?|to-?dos?|checklist)\b/i, "list-checks"],
  [/\b(projects?|folders?)\b/i, "folder"],
  [/\b(reports?|analytics|insights|stats|charts?)\b/i, "chart-column"],
  [/\b(clock|duration|hours)\b/i, "clock"],
  [/\b(home|dashboard|overview)\b/i, "house"],
  [/\b(search|find)\b/i, "search"],
  [/\b(notifications?|alerts?|reminders?)\b/i, "bell"],
  [/\b(log ?out|sign ?out)\b/i, "log-out"],
  [/\b(log ?in|sign ?in)\b/i, "log-in"],
  [/\b(profile|my account|me|user)\b/i, "user"],
  [/\b(settings?|preferences)\b/i, "settings"],
  [/\b(help|support|faq)\b/i, "circle-help"],
  [/\b(share|refer|invite)\b/i, "share-2"],
  [/\b(add|new|create)\b/i, "plus"],
  [/\b(edit|update|change)\b/i, "pencil"],
  [/\b(delete|remove)\b/i, "trash-2"],
  [/\b(filter|sort)\b/i, "sliders-horizontal"],
  [/\b(calendar|date|schedule|due|due date|tenure)\b/i, "calendar"],
  [/\b(call|phone|contact)\b/i, "phone"],
  [/\b(e-?mail|mail|message)\b/i, "mail"],
  [/\b(location|branch|atm|address|map)\b/i, "map-pin"],
  [/\b(lock|security|secure|pin|password)\b/i, "lock"],
  [/\b(documents?|kyc|file|files)\b/i, "file-text"],
  [/\b(cart|bag|shop)\b/i, "shopping-cart"],
  [/\b(favou?rites?|wishlist|like)\b/i, "heart"],
  [/\b(copy)\b/i, "copy"],
  [/\b(info|details|about)\b/i, "info"],
  [/\b(back|previous)\b/i, "arrow-left"],
  [/\b(close|cancel|dismiss)\b/i, "x"],
  [/\b(done|confirm|submit|verify|approve|save)\b/i, "check"],
  [/\b(continue|next|proceed|get started|view|view all|see all|more)\b/i, "arrow-right"],
];

/** Picks a Lucide icon name for a button or row label, or null when nothing fits. */
export function pickIconForLabel(label: string): string | null {
  const text = String(label || "").trim();
  if (!text || text.length > 60) return null;
  for (const [pattern, icon] of LABEL_ICONS) if (pattern.test(text)) return icon;
  return null;
}

/** Turns a free-text query ("credit card", "Bank") into an Iconify name candidate. */
export function iconNameFromQuery(query: string): string {
  return String(query || "").toLowerCase().replace(/^\s*(lucide:)/, "").replace(/\bicons?\b/g, "").trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

const SAFE_TAGS = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon"]);
const SAFE_ATTRS = new Set(["xmlns", "width", "height", "viewbox", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "fill-rule", "clip-rule", "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "points", "transform", "opacity", "fill-opacity", "stroke-opacity"]);

/** Keeps only plain shape SVG markup (no scripts, links, images or styles), so it is safe to hand to createNodeFromSvg. */
export function sanitizeIconSvg(svg: string): string | null {
  const text = String(svg || "").trim();
  if (!text.startsWith("<svg") || text.length > 20000) return null;
  const tags = text.match(/<\/?\s*([a-zA-Z][\w:-]*)([^>]*)>/g) || [];
  for (const tag of tags) {
    const parts = /<\/?\s*([a-zA-Z][\w:-]*)([^>]*)>/.exec(tag)!;
    if (!SAFE_TAGS.has(parts[1].toLowerCase())) return null;
    const attrs = parts[2].match(/([a-zA-Z_:][\w:.-]*)\s*=/g) || [];
    for (const attr of attrs) if (!SAFE_ATTRS.has(attr.replace(/\s*=$/, "").toLowerCase())) return null;
  }
  if (/javascript:|url\s*\(|&#/i.test(text)) return null;
  return text;
}

export type IconFetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

async function fetchSvg(fetcher: IconFetch, name: string, size: number): Promise<string | null> {
  const response = await fetcher(`${ICONIFY}/${ICON_SET}/${encodeURIComponent(name)}.svg?width=${size}&height=${size}`);
  if (!response.ok) return null;
  const body = await response.text();
  return body && body !== "404" ? sanitizeIconSvg(body) : null;
}

async function searchIcon(fetcher: IconFetch, query: string): Promise<string | null> {
  const response = await fetcher(`${ICONIFY}/search?query=${encodeURIComponent(query)}&prefix=${ICON_SET}&limit=5`);
  if (!response.ok) return null;
  const data = await response.json().catch(() => null) as { icons?: unknown } | null;
  const first = Array.isArray(data?.icons) ? data!.icons.find((icon): icon is string => typeof icon === "string" && icon.startsWith(ICON_SET + ":")) : undefined;
  return first ? first.slice(ICON_SET.length + 1) : null;
}

/** Resolves a query to {name, svg}: exact Lucide name first, then the label map, then Iconify search. */
export async function resolveIcon(fetcher: IconFetch, query: string, size = 24): Promise<{ name: string; svg: string } | null> {
  const tried = new Set<string>();
  const candidates = [iconNameFromQuery(query), pickIconForLabel(query)].filter((name): name is string => Boolean(name));
  for (const name of candidates) {
    if (tried.has(name)) continue;
    tried.add(name);
    const svg = await fetchSvg(fetcher, name, size);
    if (svg) return { name, svg };
  }
  const found = await searchIcon(fetcher, String(query).replace(/[^a-zA-Z0-9 ]+/g, " ").trim()).catch(() => null);
  if (found && !tried.has(found)) {
    const svg = await fetchSvg(fetcher, found, size);
    if (svg) return { name: found, svg };
  }
  return null;
}

/** POST body handler for /api/assistant/figma-agent/icon (fetcher injected so tests need no network). */
export async function handleIconTask(request: Request, fetcher: IconFetch): Promise<Response> {
  const headers = pluginCorsHeaders(request);
  if (!isAllowedPluginOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  const body: unknown = await request.json().catch(() => null);
  const parsed = z.object({
    queries: z.array(z.string().trim().min(1).max(80)).max(24).optional(),
    labels: z.array(z.string().trim().min(1).max(80)).max(24).optional(),
    size: z.number().int().min(12).max(64).optional(),
  }).strict().refine((data) => (data.queries?.length || 0) + (data.labels?.length || 0) > 0, "Send at least one query or label.").safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Icon task input is invalid.", details: parsed.error.issues }, { status: 400, headers });
  const size = parsed.data.size || 24;
  // Labels (auto mode) only use the fixed label map, so a label like "Total" never gets a random icon.
  const wanted = [
    ...(parsed.data.queries || []).map((query) => ({ query, byLabel: false })),
    ...(parsed.data.labels || []).map((query) => ({ query, byLabel: true })),
  ];
  const cache = new Map<string, Promise<{ name: string; svg: string } | null>>();
  const lookup = (key: string, run: () => Promise<{ name: string; svg: string } | null>) => {
    if (!cache.has(key)) cache.set(key, run().catch(() => null));
    return cache.get(key)!;
  };
  const icons = await Promise.all(wanted.map(async ({ query, byLabel }) => {
    const labelName = byLabel ? pickIconForLabel(query) : null;
    const hit = byLabel
      ? (labelName ? await lookup("name:" + labelName, async () => { const svg = await fetchSvg(fetcher, labelName, size); return svg ? { name: labelName, svg } : null; }) : null)
      : await lookup("query:" + query, () => resolveIcon(fetcher, query, size));
    return hit ? { query, name: hit.name, svg: hit.svg } : { query, name: null, svg: null };
  }));
  if (!icons.some((icon) => icon.svg)) {
    const asked = [...new Set(wanted.map((item) => item.query))].slice(0, 4).join(", ");
    return NextResponse.json({ error: `No ${ICON_SET} icon found for: ${asked}. Try a simpler word (e.g. "card", "bank", "bell").` }, { status: 404, headers });
  }
  return NextResponse.json({ ok: true, set: ICON_SET, size, icons }, { headers });
}

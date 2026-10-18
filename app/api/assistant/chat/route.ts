import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Message = { role: "user" | "assistant"; content: string };
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*:free$/i;
const MAX_MESSAGES = 80;
const MAX_TOTAL_CHARS = 80000;
const SYSTEM_PROMPT = [
  "You are UX Direct, a thoughtful senior product UX partner.",
  "Focus on evidence-led UX, information architecture, user journeys, interaction design, accessibility, and measurable business hypotheses.",
  "Prioritize Indian BFSI when relevant, especially DMI Finance, DMI Housing Finance, DMI Wealth, and Ujjivan Small Finance Bank.",
  "Be conversational like a helpful design colleague. Answer directly, explain trade-offs, and ask a follow-up only when a missing detail genuinely blocks the work.",
  "Never invent evidence, claim you inspected a website when you did not, or treat a hypothesis as a measured business outcome.",
  "For UX findings, distinguish observed evidence, interpretation, severity, recommendation, and validation.",
  "Only use retrieved approved shared-brain context when it is relevant. Current user instructions and direct evidence take precedence.",
].join(" ");

async function retrieveMemory(request: Request, query: string) {
  const token = process.env.UX_DIRECT_BRAIN_API_KEY;
  if (!token || !query.trim()) return "";
  try {
    const endpoint = new URL("/api/brain/retrieve", request.url);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        query: query.slice(0, 6000),
        scopeKeys: ["UX_SHARED_BRAIN", "indian-bfsi", "project:ux-direct", "project:ux-audit", "project:dmi-finance", "project:ujjivan-sfb"],
        limit: 6,
        maxChars: 3000,
        includeKnowledge: true,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return "";
    const payload = await response.json() as { contextText?: unknown };
    return typeof payload.contextText === "string" ? payload.contextText.slice(0, 3000) : "";
  } catch {
    return "";
  }
}

export async function POST(request: Request) {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) return NextResponse.json({ error: "OpenRouter is not configured. Add OPENROUTER_API_KEY to the UX Direct Worker secrets." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
  const value = body as Record<string, unknown>;
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (!MODEL_ID.test(model) || !model.endsWith(":free")) {
    return NextResponse.json({ error: "UX Direct chat only accepts an explicit OpenRouter model ending in :free. Paid models and automatic routing are blocked." }, { status: 400 });
  }
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > MAX_MESSAGES) return NextResponse.json({ error: "messages must contain between 1 and " + MAX_MESSAGES + " entries." }, { status: 400 });
  const messages: Message[] = [];
  let totalChars = 0;
  for (const item of value.messages) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return NextResponse.json({ error: "Invalid message entry." }, { status: 400 });
    const message = item as Record<string, unknown>;
    if ((message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string" || !message.content.trim() || message.content.length > 20000) return NextResponse.json({ error: "Each message needs a user/assistant role and non-empty text up to 20,000 characters." }, { status: 400 });
    totalChars += message.content.length;
    messages.push({ role: message.role, content: message.content });
  }
  if (totalChars > MAX_TOTAL_CHARS) return NextResponse.json({ error: "Conversation is too long. Start a new chat to continue." }, { status: 413 });
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user")?.content || "";
  const memory = await retrieveMemory(request, lastUserMessage);
  const systemContent = memory
    ? SYSTEM_PROMPT + "\n\nAPPROVED SHARED KNOWLEDGE CONTEXT (use only when relevant):\n" + memory
    : SYSTEM_PROMPT;
  try {
    const endpoint = (process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/+$/, "") + "/chat/completions";
    const origin = new URL(request.url).origin;
    const providerResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "HTTP-Referer": origin,
        "X-Title": "UX Direct",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: systemContent }, ...messages],
        stream: true,
        temperature: 0.5,
        max_tokens: 2200,
        provider: { allow_fallbacks: false },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(55000),
    });
    if (!providerResponse.ok) {
      const payload = await providerResponse.json().catch(() => ({})) as { error?: { message?: unknown } | string };
      const rawError = typeof payload.error === "string" ? payload.error : payload.error && typeof payload.error === "object" && typeof payload.error.message === "string" ? payload.error.message : "";
      const safeMessage = rawError ? rawError.slice(0, 500) : "OpenRouter returned HTTP " + providerResponse.status + ".";
      return NextResponse.json({ error: safeMessage }, { status: providerResponse.status === 429 ? 429 : 502, headers: { "Cache-Control": "no-store" } });
    }
    return new Response(providerResponse.body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Free OpenRouter inference failed.";
    return NextResponse.json({ error: message.slice(0, 500) }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { planUXTask } from "@/src/core/orchestrator";
import { mockProvider } from "@/src/providers/mock-provider";

const requestSchema = z.object({
  title: z.string().trim().min(1).max(160),
  request: z.string().trim().min(5).max(8000),
  project: z.enum(["general", "express-computers", "dmi-finance"]),
});

const ALLOWED_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);

function corsHeaders(origin: string | null): HeadersInit {
  const allowedOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://www.figma.com";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

export async function POST(request: Request) {
  const headers = corsHeaders(request.headers.get("origin"));
  const origin = request.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return NextResponse.json({ error: "Origin not allowed" }, { status: 403, headers });
  }
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Malformed JSON body" }, { status: 400, headers });
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid task input", details: parsed.error.flatten() }, { status: 400, headers });
    }

    // Mock provider only: no model API calls, Figma file access, or external writes.
    const result = await planUXTask({ ...parsed.data, provider: mockProvider });
    return NextResponse.json({ ...result, mode: "mock", cost: { currency: "INR", amount: 0 } }, { headers });
  } catch {
    return NextResponse.json({ error: "Could not create task plan" }, { status: 500, headers });
  }
}

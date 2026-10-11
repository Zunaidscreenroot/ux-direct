import { NextResponse } from "next/server";
import { z } from "zod";
import { planUXTask } from "@/src/core/orchestrator";
import { mockProvider } from "@/src/providers/mock-provider";

const requestSchema = z.object({
  title: z.string().trim().min(1).max(160),
  request: z.string().trim().min(5).max(8000),
  project: z.enum(["general", "express-computers", "dmi-finance"]),
});

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid task input", details: parsed.error.flatten() }, { status: 400 });
    }

    // Mock provider only: no model API calls, Figma access, or external writes.
    const result = await planUXTask({ ...parsed.data, provider: mockProvider });
    return NextResponse.json({ ...result, mode: "mock", cost: { currency: "INR", amount: 0 } });
  } catch {
    return NextResponse.json({ error: "Could not create task plan" }, { status: 500 });
  }
}

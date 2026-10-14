# UX Direct Intermediate Representation (UXD-IR)

## Goal

UXD-IR is the shared compact protocol for the "Infinity Stones" specialist-model architecture. It moves observable screen evidence and validated action artifacts between model stages without requiring each stage to produce a conversational explanation.

UXD-IR is **not** a universal private model language and it does not store hidden chain-of-thought. Different providers do not expose a guaranteed interoperable latent representation. The interoperable hand-off is a versioned, bounded JSON contract.

## Current pipeline

### Screen variation

1. The Cockpit sends the current request, selected-frame node tree and screenshot once to the backend.
2. **Vision stage** inspects the screenshot and emits compact UXD-IR evidence: grounded facts, existing node IDs, visible observations and uncertainties.
3. The backend validates the evidence. IDs not present in the selected frame are removed before another stage can use them.
4. **Reasoning stage** consumes the normalized evidence plus the user's intent and product guardrails. It emits a native Figma operation plan.
5. The backend validates the variation count, action allowlist, operation count and structural quality gate. The native plugin independently validates operation fields and frame scope.
6. A user confirmation precedes all mutations. The plugin duplicates the source frame and executes only within the clone; the original remains unchanged.
7. A bounded run trace stores stage IDs/status, token/cost metrics and validated artifacts. The plugin records the eventual execution result.

### Visual audit

The same vision evidence is passed to the reasoning stage, which creates 4–6 readable findings because natural-language findings are the requested deliverable. An audit does not request Figma mutations. Ordinary short chat and copy requests still use the existing free-first route and skip this two-stage image pipeline.

## Protocol shape

`src/figma/uxd-ir.ts` defines:

- `UXD_IR_VERSION`: versioned schema marker.
- `compactFigmaNodes`: a bounded index of node IDs, types, names, geometry and short text.
- `normalizeVisionEvidence`: validates evidence and scopes element/observation targets to known node IDs.
- `validateUxdirVariationPlan`: validates bounded native-operation plans.
- `UxdIrTrace`: machine-readable stages and artifacts for later diagnostics.
- `summarizeUxdIrTrace` and `classifyUxdIrError`: deterministic helper functions that do not call models.

Vision, reasoning and execution are separate roles. The provider produces evidence and a proposed plan; **the backend validates; the native Figma executor performs the actual operations**.

## Silent-by-default action mode

For actions, UX Direct shows progress and requests explicit confirmation where required, but does not add a conversational "Done" bubble after successful execution. The status/activity UI updates instead. Failures remain visible and actionable.

Audits, copy requests, risk reviews and explicit explanations return natural language because that text is the work product. The `Runs` panel also offers an explicit `Explain` action for a selected trace.

## Trace storage and on-demand explanation

The migration `supabase/migrations/20261014_uxd_run_traces.sql` creates `public.uxd_run_traces`. Before trace history can work in a deployed environment, this migration must be applied to the connected Supabase project and the Vercel backend must have the server-only Supabase credentials already used by UX Direct.

The trace table stores compact UXD-IR artifacts, not screenshots or provider credentials. RLS is enabled and client roles are not granted direct table access. API routes validate the approved Figma file, request origin and project namespace; project-scoped reads and updates prevent trace IDs from crossing the active namespace.

- `GET /api/uxd-traces?fileKey=…&project=…&limit=20` lists compact runs without full artifacts.
- `POST /api/uxd-traces` updates the status after native execution/cancellation.
- `POST /api/uxd-traces/explain` creates a readable explanation only when requested. The summary is stored after that explicit request and cached, so reopening the same run does not call another model.

The explanation endpoint summarizes observable artifacts, model stages, validation and execution results. It never claims to reveal provider-private chain-of-thought.

## Cost and safety controls

- Each stage is limited to approved models and bounded outputs.
- Paid model calls reserve cost against the existing shared rolling ₹50 / 24-hour budget before inference; estimates are also bounded by the capability's task ceiling.
- Failed paid attempts are not assumed free: the reservation stays in place if actual usage could not be verified.
- The orchestration pipeline tracks per-stage token/cost/latency where provider responses expose it.
- A short JSON artifact can still consume tokens; the benefits come from limiting context, avoiding repeated prose, avoiding unnecessary model stages, and skipping unsolicited natural-language summaries.
- Native operations stay behind the existing confirmation and plugin-side validation gates.

## Validation checklist

1. Apply the Supabase migration in the target environment.
2. Run `npm test`, `npm run typecheck` and the Next.js build.
3. In the Figma plugin, select a frame and request a variation. Verify: compact evidence → operation plan → explicit confirmation → cloned frame created.
4. Confirm the original frame is unchanged, and verify the trace status transitions from `awaiting_confirmation` to `completed` (or to `cancelled` / `failed`).
5. Open `Runs`, click `Explain`, and then click it again. The second request should return the cached explanation without a new model call.
6. Run a visual audit and confirm readable findings are returned; no design operation should be sent.
7. Verify the AI budget ledger reflects paid stage reservations/settlements. Do not treat a Vercel API deployment quota error as a successful build.

## What is not included yet

UXD-IR currently orchestrates specialist vision and reasoning for screen variations and visual audits. It is an initial implementation, not yet a universal scheduler for every UX Direct capability. General copy, routine chat and bounded edits continue on the existing routes. Broader capability orchestration should be added incrementally with capability-specific schemas and tests rather than forcing every task through the screen-variation operation contract.

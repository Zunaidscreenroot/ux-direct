# UX Direct Infinity Stones / UXD-IR

## Purpose

UX Direct uses specialist model stages instead of asking one model to inspect a Figma screen, reason about it, produce all actions, and then explain the same work in multiple long natural-language messages.

**UXD-IR (UX Direct Intermediate Representation) v1** is the compact, versioned contract between those stages. It is a shared structured protocol, not a provider's private latent/model language and not hidden chain-of-thought.

## Flow

### Variation / action task

1. The cockpit sends the user intent, selected frame node data, screenshot, allowed model candidate IDs, project namespace and the UXD-IR version.
2. The Vision Stone receives the screenshot and a bounded index of Figma node IDs. It returns compact facts, existing element IDs, visible observations and explicit uncertainties. The server drops IDs that are not in the selected node index.
3. The Reasoning Stone receives the compact evidence and user intent, not a second long visual description. It proposes an operation envelope.
4. UXD-IR validates the envelope, supported operation names, operation count, layout/structural minimum and distinct operation categories. The existing server route and native plugin still apply their own checks.
5. The cockpit shows a small confirmation prompt. The native Figma plugin executes only after approval and only within the cloned frame for variations. The source frame remains unchanged.
6. The backend stores bounded stage metadata, compact evidence and the operation plan. It does not store screenshots, provider credentials or hidden model chain-of-thought. On successful/failed execution, the native plugin updates the trace status.

### Explicit visual audit

Visual requests such as “audit the selected screen” can use the same Vision Stone evidence stage followed by a reasoning stage that produces the requested readable findings. This route is read-only; it does not create or execute Figma operations. To keep audit cost predictable, the pipeline allows at most one paid model attempt across the vision + reasoning stages, in addition to the shared rolling daily budget.

### Normal conversation

Tasks that do not require multi-stage visual work keep using the existing free-first direct route. UXD-IR is a task router, not a requirement to invoke multiple models for every greeting, copy change or simple operation.

## Cost and fallback rules

- Candidate models come from the current approved model catalogue; client-supplied IDs are re-resolved against the server catalogue and checked for availability and image support.
- Paid stages estimate cost before requesting inference and use the same Supabase-backed daily reservation/settlement ledger as other paid inference.
- A per-task cost ceiling is enforced across the staged calls.
- Vision and reasoning use bounded candidate lists, limited output-token budgets and structured output validation. If evidence or a valid plan is unavailable, the pipeline stops without sending operations to Figma.
- Compact JSON may reduce repeated prose, but is not guaranteed to be cheaper for every tokenizer/provider. Compare reported token counts, latency, cost and validated outcomes before changing a route.

## Run history and on-demand explanation

The cockpit **Runs** panel reads recent entries from `/api/uxd-traces`. A user can select **Explain** for a run to call `/api/uxd-traces/explain`. That request composes a concise, human-readable explanation from the stored stage metadata, evidence, proposed plan and execution result. Explanations are generated on demand and are not stored by default.

The trace is a structured decision/execution record. It does not claim to reproduce hidden private model reasoning. Model learning remains outcome-based: stage success, validation, tokens, latency and cost.

## Supabase setup

Apply `supabase/migrations/20261014_uxd_run_traces.sql` to the Supabase project used by the Vercel backend before using persistent trace history. The table has RLS enabled and access is granted only to `service_role`; do not expose the service key in the Figma plugin or browser. Without the migration, the trace-history API should return an explicit unavailable response rather than blocking Figma execution.

The current migration creates `public.uxd_run_traces` with project-key and timestamp indexes, a status, stage records, compact artifacts and aggregated token/cost fields. It does not store a screenshot column.

## API endpoints

- `GET /api/uxd-traces?fileKey=…&project=DMI&limit=20`: lists recent traces for the resolved project namespace; response contains compact artifacts.
- `POST /api/uxd-traces`: updates completion/cancellation/failure after the native plugin reports the result. Run updates are scoped to the run ID and project namespace.
- `POST /api/uxd-traces/explain`: makes an approved free-first or low-cost paid request to generate a readable explanation. Paid requests retain the daily spend guard.

All endpoints require the configured Figma plugin origin and allowlisted Figma file key. Traces must remain separated by project namespace.

## Validation / deployment notes

Unit tests for UXD-IR node compaction, JSON parsing, hallucinated-ID filtering, variation plan validation, trace summary and error categories are in `tests/uxd-ir.test.ts`.

The Figma plugin script can be syntax-checked independently. An end-to-end check still requires the Supabase migration, an updated Vercel preview, and a manual Figma run verifying: one screen variation is requested, source frame remains unchanged, new frames pass native operation validation, audit mode is read-only, trace status changes after execution, and only on-demand explanation generates a user-facing summary.

Vercel is the deployment target. Do not use another deployment provider as a workaround for a Vercel build/deployment quota.

# UX Direct persistent learning and spend monitoring

## What persists

UX Direct stores model-run signals in Supabase table `public.uxd_model_learning_events`. The event ledger contains the capability, provider model, model tier, whether the response passed a server-side structure gate, estimated and provider-reported cost when returned, token counts, latency, and aggregate operation counts.

It deliberately does **not** store raw prompts, screenshots, Figma file keys, layer trees, generated banking copy, account values, or other customer-facing design content in the learning ledger.

## How learning changes a future run

- The assistant reads the last 90 days of events for the current capability.
- Once a model has at least three attempts for that capability, its observed usable-response rate, validation rate, estimated average cost, and latency become eligible to influence ordering.
- Learning can only reorder models already approved by `src/figma/bfci-capabilities.ts`; it cannot bypass image support, budget reservations, model approvals, BFCI guardrails, or structured-output checks.
- Successful variation plans store counts such as total operations, structural operations, style operations, and content operations, never the actual operation text or target IDs.
- When the ledger is unavailable, the product continues with the current capability-registry order. Learning is best-effort and must not block design work.

This is persistent operational memory and adaptive routing, not fine-tuning or retraining the underlying OpenRouter models.

## OpenRouter monitoring

Set `OPENROUTER_MANAGEMENT_KEY` in Vercel Preview and Production as a server-side Sensitive variable. UX Direct uses it only for read-only monitoring calls to:

- `GET https://openrouter.ai/api/v1/credits` for account-level credit/usage information.
- `GET https://openrouter.ai/api/v1/activity` for usage grouped by model over the last 30 completed UTC days.

`OPENROUTER_API_KEY` remains the completion/inference key. The management key is never returned to the plugin or sent to Figma. The plugin reports account-level credit balance separately from the existing shared rolling 60-minute INR reservation ledger; they measure different things.

Provider usage/cost is displayed only when OpenRouter returns those fields. The ₹50 rolling-hour guard still uses conservative preflight reservations, so its remaining amount is not an exact invoice balance.

# Model Provider Evaluation (Research Snapshot: 2026-10-11)

This is a shortlist, not a decision to enable paid calls. Verify current rates, regional availability, data terms, and model identifiers again immediately before integration.

## Evaluation order

1. **Mock provider (current):** deterministic, no model API cost; use to validate orchestration, access controls, task state, and tests.
2. **Google Gemini API:** official pricing page lists a free tier for selected models and paid token-based tiers for others. Free-tier availability and data-use terms vary by model/tier; do not send confidential company/Figma content until terms are acceptable.
3. **OpenRouter:** official pricing page lists 25+ free models and a free allowance of 50 requests/day; free models can have rate limits and availability/quality variability. Paid standard usage adds a 5.5% platform fee on top of provider pricing according to the current pricing page.
4. **Other providers (OpenAI, Anthropic, DeepSeek, local models):** add only after comparing measured quality, privacy terms, latency, rate limits, and INR cost per completed task.

## Quality-first routing

Do not select a provider by price alone. Benchmark each candidate on the same fixed cases:
- Express Computers Batch 3: pattern extraction, wireframe plan, component reuse, reviewer-feedback application.
- DMI Finance: VKYC and credit-report journey, consent, OTP/verification states, errors, retries, recovery, accessibility and content.
- Figma structure: accurate interpretation of selected frame/layers and verified changes only.

Record task completion, requirement coverage, defects, manual correction time, latency, token usage, and INR estimate. A provider passes only if it meets the quality threshold; then choose the cheapest passing provider for that task class.

## Budget guardrails

- Owner's target: **₹100/day combined variable model/service spend**, not a required spend.
- Start at ₹0/day using mock/local workflows.
- A hard daily budget gate must reject requests when the estimated or actual spend would exceed the configured budget.
- Reserve stronger/paid models for tasks where measured quality justifies them.
- Subscription fees (such as a ChatGPT plan) are separate fixed costs and must be included when comparing total cost of ownership.
- No paid provider is enabled by this document.

# UX Direct — BFCI Capability Scope (v1)

**Product focus:** Banking, Financial Services and Insurance (BFCI), beginning with DMI Housing Finance.  
**Active profile:** \`bfci.dmi-hfc\`.  
**Out of scope for this release:** the second/non-BFCI product use case. The architecture must allow another profile later without mixing its prompts, model rules, memories, or quality tests into DMI.

## Product contract

UX Direct is a banking application design agent, not a general-purpose Figma chatbot with an image prompt bolted on. It must understand the screen's visual design and structure, identify the user's intended product task, choose an appropriate model budget, produce a structured plan, apply it only to an approved target, and check the result.

Supported canvases: mobile app, mobile web, desktop web, and responsive web. The design output is editable Figma nodes, not a flattened screenshot.

## Capability registry

Each capability is independently versioned and can be enabled, disabled, tested and routed without adding another branch to the main chat endpoint. A capability entry should declare:

- \`id\`, \`version\`, \`profile\`, \`enabled\`, and user-facing name.
- Input contract (prompt, selected frame/tree, screenshot, viewport/device hints and reference frames).
- Output schema and validator.
- Allowed Figma operation set and maximum operation/repair count.
- Required modality, quality rubric and minimum quality score.
- Preferred model IDs, fallback model IDs, maximum tokens, reasoning level and hard estimated-cost ceiling.
- Failure policy, whether a paid route is allowed, and whether explicit user confirmation is required.
- Tests/acceptance criteria and telemetry fields.

The router should classify tasks without spending a separate model call by default. It may use a low-cost classifier later if deterministic intent classification is ambiguous. A high-cost model is chosen only when the capability warrants it; the model must never be selected solely because it appears first in a dropdown.

## BFCI capability catalogue

| ID | Capability | Initial use in DMI HFC | Expected output | Default routing class |
|---|---|---|---|---|
| \`bfci.chat\` | Product conversation | Ask questions, discuss a selected screen | Concise response grounded in selection | Free text model |
| \`bfci.copy\` | Banking UX writing | Titles, field labels, helper text, statuses, notifications and error copy | Short options following plain-language and banking terminology rules | Free text model; paid only by explicit escalation |
| \`bfci.screen-audit\` | Screenshot + layer audit | Review spacing, hierarchy, legibility, alignment, clipping, duplication, state and CTA priority | Ranked findings tied to visible evidence and layer IDs | Free vision first if healthy; low-cost paid vision fallback |
| \`bfci.screen-redesign\` | High-quality variation / redesign | Create a genuinely distinct version of a selected DMI screen | A planned, editable sibling frame with a clear design direction and enough high-impact changes to alter hierarchy/layout | Paid visual-design model first after confirmation |
| \`bfci.screen-generation\` | New screen generation | Create a new screen from references, requirements and a device/viewport | New editable frame with correct information architecture and components | Paid visual-design model; free model can draft plan only |
| \`bfci.journey-design\` | Multi-screen journeys | VKYC, CPV, credit-report entry, loan application, repayment and failure/retry journeys | Ordered screens, entry/exit conditions, branches, statuses, and screen-level specifications | Paid reasoning model for complex flows |
| \`bfci.responsive-adaptation\` | Responsive / platform adaptation | Adapt mobile to desktop/web or vice versa | New frame(s) with layout changes based on breakpoints; never stretch-only | Paid visual-design model |
| \`bfci.design-system\` | Banking design-system use | Apply approved tokens, components, variants and patterns | Reusable components and consistent states, not isolated lookalike frames | Free for lookup; paid for creating/refactoring systems |
| \`bfci.banking-risk-review\` | BFCI trust and disclosure review | Consent, bureau permission, fees/charges, eligibility language, payment confirmation, video KYC and verification failure states | Checklist of potential UX/compliance risks with severity and rationale | Low-cost vision/reasoning model; premium adjudication only when needed |
| \`bfci.visual-qa\` | Post-edit visual verification | Compare source, proposed result and viewport | Score, detected regressions, fix list and accept/rework decision | Independent vision evaluator; escalate/repair only if score misses target |
| \`bfci.handoff\` | Design handoff | Specs for responsive behavior, states, copy, interaction and implementation notes | Developer-ready notes linked to components/nodes | Free text; paid when multi-screen/complex |

The risk-review capability is an **assistive UX review**, not legal, compliance, lending or credit-policy approval. It must not invent rates, fees, eligibility policy, legal wording, regulatory requirements or customer-specific facts. Use the approved product brief and source copy when supplied; flag missing information for DMI owners to confirm.

## DMI HFC starter domain pack

The first profile should include reusable patterns and test fixtures for:

1. Lead capture and loan application (mandatory vs optional fields, validation and consent).
2. Eligibility and offer/results screens.
3. Loan account management and loan cards.
4. EMI/payment summary, breakup, total payable, due dates and payment confirmation.
5. Credit-bureau report entry, permission and result/error states.
6. Video KYC (initiation, preparation, in-progress, completed, unsuccessful and retry).
7. CPV/physical verification and postal verification letters.
8. Empty, loading, offline, timeout, unavailable, failed, retry and success states.
9. Trust and transparency patterns: why information is collected, what happens next, charges/disclosures supplied by the product owner, and safe irreversible-action confirmation.

Treat the DMI library and reference frames as the source of truth for tokens, components, copy and patterns. Do not make up a compliance requirement or claim a design is legally compliant.

## Model routing policy

Use a capability-fit → health → quality → cost ranking. Price is considered after capability and minimum quality, not before. Treat the user's dropdown choice as a preference/manual-test target, not an instruction to use a text-only model for screenshot work.

- **Basic chat/copy:** Nemotron free text models first. No automatic paid upgrade for ordinary chat by default.
- **Visual audit:** use a healthy free vision model first; its real response, not merely its presence in the catalogue, must be verified. Fall back to the cheapest suitable paid vision model when needed and disclose this before the paid call.
- **Redesign/new screens/responsive work:** use a paid visual-capable model with a short structured plan. Start with the best cost/quality fit (GLM-4.6V or Claude Haiku 5.5 for first pass); escalate to Kimi K2.5 or Gemini 3.1 Pro for hard tasks; Claude Sonnet 5.5 is the premium fallback/judge rather than the default for every request.
- **Complex journeys/design systems/risk reviews:** use low reasoning effort to draft the structure; raise effort or model quality only when validation fails or complexity requires it.
- **Retry policy:** at most one alternate model per step, and at most two bounded quality-repair passes. Never keep retrying indefinitely. Provider errors, empty content, malformed JSON and low-quality plans are separate outcomes.
- **Quality gate:** target \`>= 90/100\` against task-specific criteria. Reject a plan that only renames a clone or changes one minor color when the task requested a redesign. Verify that required content and key financial information are preserved.
- **Paid-cost controls:** estimate cost from current catalogue rates and input/output token limits before the call, ask before paid processing where the task is high-compute, capture provider-reported usage/cost where available, and enforce a shared transactional rolling-hour cap. Initial working budget target: **₹50 per 60-minute window** across all paid inference from UX Direct, including manual paid-model tests. Reservations use a ₹100/USD conversion buffer and 1.5× safety factor; failed paid attempts remain reserved for 60 minutes because the provider may still bill them. If the shared ledger is unavailable, paid inference fails closed; free models remain available. Unknown-price models are manual-only until price/capability metadata is verified.
- **No silent cost escalation:** if the budget is exhausted or the paid call is not approved, return the best free plan and explain what cannot be completed at that tier.

## Initial model shortlist (prices are list prices per 1M tokens)

Prices can change and provider-specific endpoints may differ. Refresh them from the live catalogue, then smoke-test the exact endpoint. Image-token charges and reasoning tokens may affect the actual cost.

| Model ID | Input / output | Modalities / fit | Proposed role |
|---|---:|---|---|
| \`nvidia/nemotron-3.5-lightning:free\` | Free | Text | Default chat/copy |
| \`nvidia/nemotron-3-ultra-550b-a55b:free\` | Free | Text | Free reasoning fallback |
| \`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free\` | Free | Text + image | Experimental free visual fallback; don't trust availability flag without a real response test |
| \`anthropic/claude-haiku-5.5\` | $0.10 / $0.50 | Text + image; structured output | Low-cost vision audit and structured plan |
| \`deepseek/deepseek-v4.1-flash\` | $0.13 / $0.52 (listed) | Text + image; tool/structured output | Cheap multimodal reasoning fallback |
| \`z-ai/glm-4.6v\` | $0.30 / $0.90 | High-fidelity image/layout understanding; UI reconstruction | Visual redesign and layout analysis |
| \`moonshotai/kimi-k2.5\` | $0.45 / $2.25 | Multimodal, visual coding and agentic tasks | Higher-quality redesign/journey fallback |
| \`google/gemini-3.1-pro-preview\` | $2 / $12 (standard) | Text + image, long-context reasoning | Complex multi-screen planning/escalation |
| \`anthropic/claude-sonnet-5.5\` | $2 / $10 (standard) | Text + image, high-quality structured work | Premium visual QA / hardest design tasks |
| \`deepseek/deepseek-v4-flash-0731\` | $0.0152 / $1.28 (listed) | Text | Cheap input, but cap output tokens because output is relatively more expensive |

Existing \`openai/gpt-6-luna\` stays in the manual catalogue only until its current rate and image support are verified. Any additional model must have an exact ID, supported modalities, current pricing, capability tests and fallback rules before it becomes eligible for automatic routing.

## Why stronger variation needs more than a stronger model

Current variation execution is intentionally narrow: the model is instructed to make only a few operations, and native Figma execution supports only a small operation list. That setup naturally produces a near-clone. The high-quality redesign milestone must extend the operation schema and its validator to support layout/auto-layout, spacing/padding, typography styles, strokes/radii, grouping/frames, visibility and safe restructuring/reordering inside the duplicate. The operation budget should depend on screen complexity (not a fixed 3–5 edits).

## High-quality generation pipeline

1. **Understand:** inspect the actual screenshot and selected frame tree, viewport, reference frames and active DMI profile.
2. **Specify:** create a design brief that states the UX issues and intended layout/interaction changes.
3. **Plan:** generate a structured operation plan scoped to a duplicate frame.
4. **Validate:** check IDs, operation support, financial-content preservation, component/tokens compliance and whether the proposal is substantial enough for the requested task.
5. **Apply:** after explicit approval, clone the source and execute only against the clone.
6. **Evaluate:** capture the clone screenshot and independently score information hierarchy, task clarity, consistency, spacing/alignment, typography/contrast, density, responsive fit, DMI pattern use, and regressions.
7. **Repair:** if below 90/100 or a hard blocker is detected, ask the router for a bounded repair; re-capture/re-score. Never declare success on plan generation alone.
8. **Report:** show model path, why it was selected, cost/usage where available, quality score, changes applied and any remaining issues.

## Telemetry and acceptance tests

Track capability ID/version, device type, selected-frame fingerprint, selected model, fallback reason, input/output/reasoning tokens, estimated and actual cost, latency, retries, operation count, quality score, failed validators, and whether the user accepted the result. Do not log customer PII or raw banking information by default.

Initial acceptance tests:
- A greeting or short UI-copy request uses a free text model and makes no paid inference.
- A screenshot question routes to a model that actually accepts images.
- A screen-redesign request proposes structural/layout improvements, not just renames and minor fill edits.
- One variation creates exactly one editable sibling frame; original node properties remain unchanged.
- A malformed response or empty reasoning response triggers a bounded fallback.
- A paid request is blocked until approved; no model is called after the daily cap is exhausted.
- The output preserves all required financial amounts, due dates, fee/disclosure placeholders and consent semantics.
- A newly registered capability can be added with its schema, allowed operations, model policy and tests without rewriting the shared chat endpoint.

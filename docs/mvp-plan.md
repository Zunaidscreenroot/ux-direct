# UX Direct MVP Plan

## Phase 0 — Repository and runtime foundation

- Establish app structure, linting, type checking, tests, and environment configuration.
- Define task, project context, capability, model result, and QA report types.
- Add a mock model provider so core workflows can be tested without paid API calls.
- Keep secrets out of source control.

## Phase 1 — One end-to-end vertical slice

Input: a task brief plus a small set of approved reference screens or extracted design context.

Output:
1. Normalized requirements and assumptions.
2. Relevant product patterns and evidence.
3. Proposed journey/screen plan.
4. Structured design instructions.
5. UX and edge-case critique.
6. Final rationale and QA report.

Initially, validate the reasoning and artifacts before allowing broad automatic Figma mutations.

## Phase 2 — Figma context extraction

For an explicitly allowlisted file, collect only supported information needed for the task: relevant node tree, text, layout/properties, component relationships, styles/tokens, and visual references where available. Preserve source node IDs and provenance. Test permissions and error handling.

## Phase 3 — Design execution

Convert validated Design IR into scoped Figma operations. Verify the resulting document after every meaningful batch. Use safe, reversible changes where possible and gate destructive operations.

## Phase 4 — Quality and bounded iteration

Run separate reviews for:
- requirement coverage and business logic
- information hierarchy and journey completeness
- content and UX writing
- consistency with existing product patterns
- accessibility and responsive behavior
- loading, empty, error, timeout, retry, rejection, recovery, and back-navigation states
- visual comparison and component correctness

Revise no more than 3 times initially; show unresolved issues instead of looping indefinitely.

## First proving tasks

### Express Computers — Batch 3
- Identify relevant Batch 1/2 patterns and reviewer feedback.
- Infer component, content, hierarchy, and layout rules.
- Map Batch 3 requirements to proposed screens and states.
- Produce editable, review-ready output with rationale and QA.

### DMI Finance — VKYC and Credit Report
- Infer the existing product language from approved references.
- Design the VKYC entry tile/banner and end-to-end states, including consent and verification states where required by the confirmed product flow.
- Add the credit-report entry point and preserve continuity into the existing journey.
- Explicitly flag assumptions around consent, OTP, bureau checks, and compliance for human confirmation.

## Evaluation

For each real task, record:
- requirement coverage
- senior-review quality feedback
- visual/product consistency
- defects found after self-critique
- successful tool execution rate
- latency and model cost
- number of iterations
- human interventions and unresolved assumptions

Do not label a design “100% perfect.” Define measurable acceptance criteria, retain evidence, and make uncertainty visible.

# UX Direct

**An AI senior-level UX employee** — an autonomous product-design partner that understands requirements, researches, reasons, designs, critiques, iterates, and prepares evidence-backed, review-ready work.

UX Direct is the sole product repository for this project. The existing `figma-design-agent` repository is out of scope and must not be modified.

## First proving grounds

- **Express Computers:** infer reusable patterns from earlier batches and produce review-ready Batch 3 screens.
- **DMI Finance:** design the VKYC tile/banner and journey, plus the credit-report entry point, using existing product patterns and careful consent, verification, error, retry, and recovery states.

These use cases validate the product; they do not limit its future capabilities.

## Product principles

- Think like an exceptional senior UX designer, not a generic screen generator.
- Reuse a product's design language, not merely copy its screens.
- Explain design decisions and connect them to requirements and evidence.
- Generate alternatives when the decision is meaningful; recommend one with rationale.
- Run UX, visual, accessibility, content, consistency, and edge-case reviews.
- Self-critique and self-correct within a bounded iteration budget before requesting human review.
- Route work to the least expensive model that can reliably perform it; keep providers interchangeable.
- Never claim an operation succeeded unless execution and verification confirm it.
- Keep human approval for ambiguous business decisions and destructive or high-impact actions.

## Initial architecture

1. **Product cockpit** — conversational task intake and progress.
2. **Task orchestrator** — decomposes work, tracks state, and routes capabilities.
3. **Context and product memory** — requirements, Figma-derived patterns, decisions, feedback, and evidence.
4. **Model gateway** — provider-independent routing for local, free, and paid models.
5. **UX reasoning and design planning** — journeys, IA, interaction logic, content, alternatives, and rationale.
6. **Design representation** — structured, validated design instructions before execution.
7. **Figma execution adapter** — uses supported and authorized Figma capabilities.
8. **Quality gates** — UX critique, visual comparison, accessibility, edge cases, and bounded revision.
9. **Observability** — progress, model/provider, cost, latency, iterations, failures, and audit history.

## MVP success criteria

A real task should result in editable, product-consistent design output plus rationale, requirement coverage, key edge states, QA findings, and a clear list of unresolved assumptions. Evaluate quality, cost, latency, reliability, and the amount of human intervention.

## Development status

This repository is being initialized. Start with a small, testable vertical slice rather than attempting every capability at once. Keep architecture extensible and measure each addition against real Express Computers and DMI Finance work.

## Backend and Figma plugin

UX Direct uses a direct architecture: the Figma plugin calls the UX Direct backend APIs, while the backend handles task planning, model routing, quality checks, telemetry, and plugin health commands. The plugin heartbeat and controlled native API self-test use the private Vercel Blob store for shared session/command state.

For local plugin development, import `figma-plugin/manifest.json` in Figma Desktop. The current preview plugin backend is configured in `figma-plugin/ui.html` and allowed by `figma-plugin/manifest.json`. Update both when testing a different preview URL.

The backend and Figma plugin communicate directly. A separate ChatGPT MCP server, OAuth handshake, or ChatGPT activity bridge is not part of this architecture. The model gateway and Figma plugin remain the foundation for a future cost-optimized native Figma workflow.

## Vercel storage

The Figma plugin bridge, model usage ledger, and gateway settings use the project's private Vercel Blob store. Keep the `BLOB_READ_WRITE_TOKEN` attached to the Vercel project for Preview and Production environments. Blob keys are namespaced by feature and branch so preview configuration and usage records do not overwrite production records. Legacy Netlify Blob records are not automatically copied into Vercel Blob; historical records must be exported from Netlify and imported separately if needed.

## Security

- Keep API keys in environment variables; never commit secrets.
- Limit Figma access to explicitly authorized files and operations.
- Treat client documents and designs as confidential.
- Log actions and provide safeguards for destructive changes.
- Verify permissions and API support at runtime; do not infer unrestricted access from account role alone.

## Getting started

The application scaffold and implementation plan will be added incrementally. See [Architecture](docs/architecture.md), [MVP plan](docs/mvp-plan.md), [Model Gateway](docs/model-gateway.md), and the [free-first provider setup](docs/model-gateway-providers.md). The gateway is a zero-fee application module; leave paid model keys blank until the mock/local/free-tier test checklist passes.

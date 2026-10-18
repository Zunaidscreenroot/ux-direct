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

## Shared Brain

UX Direct owns the persistent, model-agnostic memory used by UX Direct, UX Audit and the Figma plugin. ChatGPT can turn natural-language or Hindi/Hinglish coaching into a draft rule; the rule becomes active only after explicit approval. The shared brain stores approved reusable knowledge and source-backed references, while client audit reports stay in the separate Past findings store.

The backend now includes scoped retrieval, keyword search, optional vector embeddings, bounded context injection, deduplication/idempotency, validity dates and a retrieval evaluation harness. This is external memory/retrieval—not a model-weight fine-tune—and it must remain evidence-led. See [Shared Brain architecture](docs/shared-brain-memory.md) for the lifecycle, scope rules, cost controls and open-source concepts adopted.

## Development status

The first shared-memory vertical slice is implemented behind the backend API and MCP tools. Validate with real owner corrections and subsequent audits before making claims about accuracy or token savings. Keep work measurable against actual UX Direct/Figma and UX Audit tasks.

## Security

- Keep API keys in environment variables; never commit secrets.
- Limit Figma access to explicitly authorized files and operations.
- Treat client documents and designs as confidential.
- Log actions and provide safeguards for destructive changes.
- Verify permissions and API support at runtime; do not infer unrestricted access from account role alone.

## Getting started

The application scaffold and implementation plan will be added incrementally. See [Architecture](docs/architecture.md), [Shared Brain](docs/shared-brain-memory.md), [MVP plan](docs/mvp-plan.md), [Model Gateway](docs/model-gateway.md), and the [free-first provider setup](docs/model-gateway-providers.md). The gateway is a zero-fee application module; leave paid model keys blank until the mock/local/free-tier test checklist passes.

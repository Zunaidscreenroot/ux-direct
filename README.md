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

## IA discovery and UX audit workbenches

The cockpit sidebar links to two focused workbenches:

- **IA discovery** at `/ia-demo`: bounded, same-origin site crawling, page/headings extraction, expandable interactive React Flow map, and page-level source details. The Cloudflare Worker uses a small fetch-based crawler with page/depth caps. The optional Node CLI uses Crawlee's CheerioCrawler: `node scripts/ia-crawl.mjs https://example.com 18 3` (Node.js 22.13+; no Playwright/Puppeteer).
- **UX audit and benchmarking** at `/audit-demo`: supply public HTTPS screenshot URLs from thum.io or public R2 image URLs using `Site name | Step/page label | Screenshot URL`, one entry per line. Auditing uses the existing Model Gateway pinned to `UXD_AUDIT_MODEL` (default `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`, already present in the current Worker allowlist) through FreeLLMAPI. Configure FREELLMAPI_BASE_URL, FREELLMAPI_API_KEY, and a vision-capable upstream model in FreeLLMAPI. The router must support image input for screenshot audits. The report includes stable categories, severity-calibrated findings, normalized screenshot-region annotations, limitations, and like-for-like competitor comparisons.
- **Lighthouse**: the workbench calls Browserless' remote `/performance` endpoint. Configure `BROWSERLESS_API_TOKEN` (or `BROWSERLESS_API_KEY` / `BROWSERLESS_TOKEN`) and optionally `BROWSERLESS_BASE_URL`.

UX Audit Skill reuse is deliberately limited to category IDs, severity calibration, duplicate reduction, and screenshot-region marking. axe-core is training/reference only and is not in runtime dependencies or audit execution. Do not send confidential client screenshots to free model endpoints unless the provider's data terms have been approved.

## Development status

This repository is being initialized. Start with a small, testable vertical slice rather than attempting every capability at once. Keep architecture extensible and measure each addition against real Express Computers and DMI Finance work.

## Security

- Keep API keys in environment variables; never commit secrets.
- Limit Figma access to explicitly authorized files and operations.
- Treat client documents and designs as confidential.
- Log actions and provide safeguards for destructive changes.
- Verify permissions and API support at runtime; do not infer unrestricted access from account role alone.

## Getting started

The application scaffold and implementation plan will be added incrementally. See [Architecture](docs/architecture.md), [Shared Product Brain](docs/shared-product-brain.md), [MVP plan](docs/mvp-plan.md), [Model Gateway](docs/model-gateway.md), and the [free-first provider setup](docs/model-gateway-providers.md). The gateway has no gateway SaaS fee. Upstream providers can still charge; validate FreeLLMAPI routing profiles, quotas, and privacy terms before sending client material.

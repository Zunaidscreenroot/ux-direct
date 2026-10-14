# UX Direct

**An AI senior-level UX employee** — an autonomous product-design partner that understands requirements, researches, reasons, designs, critiques, iterates, and prepares evidence-backed, review-ready work.

UX Direct is the sole product repository for this product. The existing `figma-design-agent` repository is out of scope and must not be modified.

## Product operating model: one Brain, multiple Hands

- **Brain:** one shared backend on Vercel owns orchestration, project context, RAG/CAG, approved memory, model routing, budget controls, quality gates and telemetry.
- **Cockpit:** the primary, always-available daily hand for screen generation, redesign, iteration and routine audits.
- **Specialist hands:** separate, independently installable Figma plugins that share the same Brain. Initial specialist hands are Wireframe Foundry, UX Auditor, Benchmark Lab, Journey Architect, and UX Quality & Handoff.
- **One repository:** shared contracts, service logic, tests and docs live here. Each hand has its own plugin UI/manifest/entry point and its own build target, but not a separate copy of the model gateway or knowledge system.

See the [Universal UX Brain Architecture](docs/universal-ux-brain-architecture.md), [Modular Hands](docs/modular-hands-architecture.md), the [Architecture](docs/architecture.md), and the [BFCI capability scope](docs/bfci-capability-scope.md).

## Project workflows

### Existing / brownfield: DMI

DMI Housing Finance, DMI Finance and DMI Wealth use Brain + Cockpit by default. Existing approved patterns and memory should be reused. Specialist hands are invoked only when the task warrants them; DMI is not forced through a greenfield foundation process.

### New / greenfield: Ujjivan Small Finance Bank

The Brain can coordinate Benchmark Lab, Journey Architect, Wireframe Foundry, UX Auditor and Quality & Handoff to establish the project's initial foundation. After the wireframe kit is reviewed and approved, Cockpit stays the primary daily hand and specialist hands remain available on demand.

Project-specific source material, patterns and memory remain isolated. Only approved generic BFCI knowledge or explicitly approved shared material may cross client boundaries.

## Product principles

- Think like an exceptional senior UX designer, not a generic screen generator.
- Reuse a product's design language, not merely copy its screens.
- Explain design decisions and connect them to requirements and evidence.
- Generate alternatives when the decision is meaningful; recommend one with rationale.
- Run UX, visual, accessibility, content, consistency and edge-case reviews.
- Self-critique within a bounded iteration and spend budget.
- Route server-side to the least expensive model that can reliably perform the task; verify modality and actual health, not just catalogue presence.
- Never claim an operation succeeded unless execution and verification confirm it.
- Keep human approval for ambiguous business decisions and destructive or high-impact actions.
- Treat the Wireframe Foundry output as a reusable high-fidelity UX wireframing system, not the UI team's final production design system.

## Shared architecture

1. **Plugin hands** — independent Figma UIs and scoped Figma operations.
2. **Capability registry** — versioned inputs, outputs, allowed actions, quality rubrics, budget policies and tests.
3. **Task orchestrator** — decomposes work, tracks state and invokes applicable capabilities.
4. **Project context and memory** — separates generic BFCI knowledge, client-level context and project-specific evidence.
5. **Model gateway** — server-side provider routing, capability checks, usage/cost accounting and bounded fallback.
6. **Design representation** — structured and validated instructions before Figma execution.
7. **Quality gates** — UX, visual, accessibility, content, journey and structural validation.
8. **Observability** — progress, model/provider, estimates and reported costs, latency, iterations, failures and audit history.

## Current architecture scaffold

The modular-hands branch introduces the shared hand request/result contracts, hand catalogue, explicit DMI/Ujjivan project profiles and tests for project workflow selection. Treat these definitions as a scaffold until they are wired to the backend and each plugin's build/runtime.

## Security

- Keep API keys server-side in environment variables; never commit secrets or embed them in Figma plugin bundles.
- Keep model routing and system-prompt policy in the shared Brain; plugins send task intent and verified local Figma context.
- Limit Figma access to explicitly authorized files and operations.
- Treat client documents, designs and project memory as confidential.
- Log actions and provide safeguards for destructive changes.
- Verify permissions and API support at runtime; do not infer unrestricted access from account role alone.
- Do not deploy automatically from architecture work; build, test, review and deploy as separate steps.

## Getting started

See [Architecture](docs/architecture.md), [Modular Hands Architecture](docs/modular-hands-architecture.md), [MVP plan](docs/mvp-plan.md), [Model Gateway](docs/model-gateway.md), and the [free-first provider setup](docs/model-gateway-providers.md). Keep paid model keys blank until the mock/local/free-tier test checklist passes.

# UX Direct — Modular Hands

This document defines plugin boundaries. The canonical reasoning architecture is [Universal UX Brain Architecture](universal-ux-brain-architecture.md).

## Product contract

**One Brain, multiple hands.**

- **Brain:** one shared backend owns world-model access, reasoning/planning, tool discovery, model routing, context retrieval, budgets, policies, quality decisions and learning records.
- **Cockpit:** the primary 24×7 daily Figma hand for design creation, redesign, routine audit and iteration.
- **Specialist hands:** separately installable Figma plugins providing focused execution surfaces and tools. They are on demand; they do not contain independent project-specific brains.

The word "24×7" means Cockpit is the primary always-available workspace, not that paid model calls should run continuously in the background.

## Hands catalogue

| Hand | Tools/capabilities it can expose | Intended use |
|---|---|---|
| Cockpit | Read selection/frame, capture visual context, create/redesign/iterate screens, apply patterns, verify edits | Default daily work across all projects |
| Wireframe Foundry | Analyse approved references, create polished high-fidelity wireframe components/states, produce a versioned pattern manifest | Initial setup or deliberate refinement of a reusable wireframe kit |
| UX Auditor | Heuristic, visual, forms, content, trust, accessibility and journey-coverage analysis | Deep/independent review when valuable |
| Benchmark Lab | Gather permitted public/approved evidence, compare flows and patterns, record provenance | Research when more evidence could change a decision |
| Journey Architect | Model requirements, states, transitions, branches, data and recovery paths | Complex or underspecified journeys |
| UX Quality & Handoff | Regression, conformance, responsive/accessibility checks and implementation-facing notes | High-impact changes and delivery milestones |

These are execution surfaces and capability providers, not a fixed list of tasks the Brain understands. The Brain can compose a plan from any compatible tools it discovers. A specialist should not be invoked merely because it exists.

## Project context, not project-specific intelligence

DMI and Ujjivan do not get separate reasoning engines or mandatory code-defined task sequences.

- **DMI:** existing screens, approved patterns and current requirements normally make direct Brain + Cockpit execution the least-friction plan. Specialists remain available when evidence or task complexity warrants them.
- **Ujjivan:** the current artifact and knowledge state may reveal missing foundations. The Brain can choose research, journey modelling and Wireframe Foundry where useful; this is a task/state-driven plan, not a hardcoded greenfield workflow.
- **Any other workspace:** can be added as data with scoped evidence and permissions, without adding a new project enum or new branch in the planner.

Workspace identity exists for information retrieval, access control, provenance and decision traceability. It must not dictate a mandatory plan or constrain the Brain's reasoning. A world-model query must enforce exact project/client scope before evidence reaches a planner.

## Plugin/backend contract

Each hand has its own Figma `manifest.json`, UI, plugin entry point and build target. Hands share the versioned request/result contracts in `src/core/hand-contracts.ts` and the same backend deployment.

A task request includes the hand ID, capability/tool intent, workspace ID when known, request/idempotency IDs and verified local Figma context. It does not send provider keys or dictate a client-built system prompt. The Brain resolves evidence, discovers eligible tools and builds the plan server-side.

A tool definition describes:
- Version, description, input validator and expected output/evidence.
- Operation type, modality, tags and availability.
- Provider/hand, risk, cost class and approval requirements.

The plugin executes only policy-approved operations, returns actual execution evidence, and the Brain verifies postconditions before marking a task complete.

## Wireframe Foundry boundary

Foundry creates a **reusable high-fidelity UX wireframe kit**, not the UI team's final production design system. It can output native editable Figma components, provisional styles/tokens, relevant BFCI patterns, states and a versioned manifest for Cockpit.

No client branding is invented. Source/asset provenance and applicable licences are tracked. Once approved, the kit becomes a versioned project artifact that Cockpit can consume. A new screen does not require rebuilding the kit.

## Security, budget and quality

- Keep provider credentials and model routing server-side.
- Enforce tool allowlists, workspace scope, modality support and actual Figma permissions.
- Require appropriate approval for write operations; preserve originals by default.
- Reserve paid budget before a paid call; fail closed if the price catalogue or ledger is unavailable.
- Treat a failed provider call as potentially billable; never blindly retry.
- Prefer deterministic validators before paid visual critique.
- Report completion only after execution and postcondition checks.
- Save provenance, concise decision records, validation, cost and execution traces—not private chain-of-thought.
- Cross-client learning is restricted to approved generic knowledge; project/client source material remains scoped.

## Implementation order

1. Validate shared contracts, world-model scope rules, tool discovery and plan validation.
2. Wire persistent knowledge and actual backend planning to these contracts.
3. Connect Cockpit first and prove a bounded read-plan-write-verify task.
4. Build Wireframe Foundry as the first specialist hand and validate its manifest in Cockpit.
5. Add audit, research, journey and quality tools as needed—without adding independent brains.

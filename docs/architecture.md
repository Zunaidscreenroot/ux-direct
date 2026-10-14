# UX Direct Architecture

> The detailed target is defined in [Universal UX Brain Architecture](universal-ux-brain-architecture.md). This file is the concise system overview.

## Design goal

Build one general UX intelligence that can reason across projects, build a scoped world model from evidence, discover execution tools at runtime, construct adaptive plans and verify outcomes. Workspace context is for state, provenance and access boundaries—not a separate intelligence or a hardcoded workflow.

## Logical flow

```text
User request
  -> Task intake / cockpit
  -> Context resolver
  -> Task planner and orchestrator
  -> Scoped world model + runtime tool registry
  -> Director meta-controller / dynamic planning
  -> Structured Design IR + policy validation
  -> Selected hand/tool execution
  -> Evidence-backed verification and bounded repair
  -> Model gateway (local / free / paid providers)
  -> Execute approved plan
  -> Validate result
  -> bounded self-correction (maximum 3 iterations initially)
  -> review-ready package + audit record
```

## Core modules

- **Task orchestration:** explicit task states, steps, retries, cancellation, and checkpoints.
- **Runtime tool registry:** discovers concrete executable affordances with schemas, modality, availability, risk, costs, approval requirements and expected evidence. Its inventory is extensible and does not constrain what the Brain can reason about.
- **Product world model:** connects versioned requirements, claims, decisions, user needs, journey states, constraints, components, risks and artifacts through evidence-backed relations.
- **Workspace context:** enforces client/project scope and resolves relevant current state; it does not prescribe a sequence of task steps.
- **Multi-timescale memory:** separates task-local context, episodic execution outcomes, approved semantic facts, reusable procedures and calibrated user preferences.
- **Director meta-controller:** assesses uncertainty, downstream risk, value of information and whether a specialist/model call is worth its cost; composes the plan dynamically.
- **Model gateway:** one server-side interface for model providers. Route by required modality, health, minimum quality, privacy, latency and cost; reserve budget before paid inference.
- **Design IR/compiler:** validated semantic representation for requirements, journeys, screens, layout, components, content, interactions, invariants and acceptance criteria; adapters compile it to allowed Figma operations.
- **Quality gates:** requirement coverage, journey completeness, visual consistency, accessibility, UX writing, responsive behavior, edge states, and interaction integrity.
- **Figma adapter:** checks API support and permissions, executes scoped changes, and verifies resulting nodes rather than trusting a model's claims.
- **Observability:** record task status, model/provider, duration, cost estimate, iteration count, tool actions, validation results, and errors.

## Model routing

Use the least expensive model that can reliably complete a task. Cheap/local models can handle classification, extraction, tagging, and simple commands. Use stronger models for complex UX decisions, difficult critique, and visual reasoning. Escalate only when quality or confidence warrants it. Cache repeatable results where safe. Track actual costs before setting a hard monthly budget.

## Figma security boundary

- Start in read-only analysis mode.
- Allowlist file IDs before any access or mutation.
- Separate read and write permissions.
- Require extra safeguards for deletion, broad replacement, or large batch edits.
- Log operations and verification results.
- Treat Plugin API, REST API, and external tools as distinct capability surfaces.
- Never promise an operation until its API support, permissions, and execution path are tested.

## Quality loop

Understand -> retrieve evidence -> plan -> compare alternatives -> execute -> critique -> validate -> revise (up to 3 iterations initially) -> present rationale, confidence, known gaps, and next decisions.

## Current implementation status

The modular-hands feature branch contains initial primitives for the world model, runtime tool discovery, director planning context, plan validation and workspace-scoped metadata. They are not yet wired end-to-end into the production backend or real Figma execution.

- Keep all work in this repository; do not modify or depend on the separate `figma-design-agent` repository.
- Do not train a foundation model from scratch as a prerequisite. Prioritise retrieval, structured world state, tool composition and evaluation.
- Persist facts, evidence and decisions only through a store that enforces workspace scope. The in-memory world model is currently a reference implementation.
- Keep model credentials, routing and paid-budget enforcement server-side.
- Deployments stay separate from feature-branch architecture work.

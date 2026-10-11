# UX Direct Architecture

## Design goal

Build an AI senior-level UX employee, not a one-shot UI generator. The system should be model-agnostic, capability-driven, observable, and able to improve work through evidence-based critique and bounded iteration.

## Logical flow

```text
User request
  -> Task intake / cockpit
  -> Context resolver
  -> Task planner and orchestrator
  -> Capability registry
       |-- requirements and research
       |-- UX strategy / journey / IA
       |-- product-pattern extraction
       |-- design planning and structured Design IR
       |-- UX / content / accessibility critique
       |-- visual QA and comparison
       |-- Figma read/write adapter
  -> Model gateway (local / free / paid providers)
  -> Execute approved plan
  -> Validate result
  -> bounded self-correction (maximum 3 iterations initially)
  -> review-ready package + audit record
```

## Core modules

- **Task orchestration:** explicit task states, steps, retries, cancellation, and checkpoints.
- **Capability registry:** each capability declares inputs, outputs, dependencies, permission requirements, risk, cost class, and tests.
- **Context resolver:** retrieves relevant project, client, design, and task context; surfaces conflicts instead of silently guessing.
- **Product memory:** separates observed facts, candidate patterns, and trusted/approved patterns. Keep evidence and provenance with each memory item.
- **Model gateway:** one internal interface for multiple model providers and local models. Route by task complexity, vision needs, privacy, quality, latency, availability, and cost.
- **Design IR:** validated structured representation for screens, layout, components, content, interactions, and rationale; adapters translate it to Figma operations.
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

## Initial architecture decisions

- Keep the product in this repository only.
- Do not depend on the separate `figma-design-agent` repository.
- Do not train a foundation model from scratch; use model APIs/local models plus project memory and retrieval.
- Do not add a database or external service until the MVP requires persistence; keep interfaces ready for one.

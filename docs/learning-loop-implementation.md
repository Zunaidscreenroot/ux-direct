# Learning loop implementation notes

This batch adds provider-neutral primitives; it does not claim that a persistent production learning pipeline or Figma renderer is already wired end-to-end.

## Design IR
- `src/core/design-ir.ts` validates a versioned, structured screen tree, token references, unique node IDs, and requirement-to-node links.
- It deliberately does not execute Figma mutations. A future renderer must map only supported, allow-listed operations and verify the read-back result.
- `summarizeDesignIR` produces a compact deterministic summary for tests, audits, and later benchmark records.

## Resumable task lifecycle
- `src/core/task-state-machine.ts` defines allowed transitions, records transition reasons/timestamps, and bounds retry attempts.
- Persisting its history across serverless restarts still requires a reviewed durable store and authenticated tenant scoping.

## Expert feedback and memory promotion
- `src/memory/learning-feedback.ts` validates a structured critique rubric and creates a memory candidate with provenance.
- Expert-model and automated-check feedback are never trusted automatically. Promotion requires accepted human feedback with confidence >= 0.7.
- Existing in-process `ProjectMemory` is not durable. Do not represent it as cross-session learning until a tenant-scoped persistent adapter is implemented and verified.

## Cost and deployment constraints
- These modules make no model calls and introduce no paid dependencies.
- The batch is committed as one commit to the existing feature branch. GitHub Actions CI can run on the pull request; Vercel deployment behavior depends on the connected project’s Git settings and cannot be guaranteed by a repository commit alone.

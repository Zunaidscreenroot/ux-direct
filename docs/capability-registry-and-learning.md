# Capability Registry and Evidence-Backed Learning

## One Brain, open capability surface

UX Direct has one universal Brain. Domain labels such as website, mobile application, banking journey or a future product category are intent and context—not reasons to create another intelligence or hardcoded workflow.

Add a capability by registering a versioned implementation with a stable ID, clear purpose, tags, supported modalities, input validation, availability/health check, risk/cost class, approval needs and result contract. The Brain discovers capabilities at runtime and composes plans from the capabilities that are currently available and permitted. The registry is extensible; the current catalogue is a starter set, not a closed taxonomy.

Use distinct layers for different concerns:

- **Capability registry:** product-level abilities a planner may ask for, such as requirement extraction, website reconnaissance or journey inspection.
- **Runtime tool registry:** concrete executable operations exposed by a hand, adapter, model or external service. It remains the execution-policy boundary.
- **Director Brain:** interprets the request and current world state, chooses which abilities are useful, and creates a non-linear plan.
- **World model:** stores scoped facts, decisions, provenance, artifacts and dependencies.
- **Learning loop:** evaluates observed outcomes and suggests better-performing capability/strategy combinations.

A capability registration never implies that an adapter is connected. Unavailable implementations should report `available: false` or fail with a clear adapter-not-connected error. Never represent a placeholder as a completed browser/Figma/app operation.

## Adding a future domain

For example, to support a new application type:

1. Implement the required capability/adapter with its own schema, evidence and verification contract.
2. Register it with domain-neutral tags and real modality/availability metadata.
3. Add deterministic tests and scope/permission checks for its input and outputs.
4. The Brain discovers it when relevant; the existing planner composes it with other tools when dependencies and policies permit.
5. Observe verified outcomes and corrections before recommending its strategy more often.

No new brain, client enum or fixed workflow is required. New capabilities should not receive permissions simply because they have been registered.

## Learning from actions—not from unverified model claims

The learning loop records compact operational observations: capability and strategy IDs, scope, outcome, verification/validation signal, quality score, correction count, latency/cost when available, timestamps and evidence kind. It intentionally excludes raw prompts, screenshots, layer trees, customer design content and private chain-of-thought.

A strategy may become a **recommendation** only when it has sufficient scoped evidence (three observations by default), strong verified acceptance, high validation pass rate and acceptable quality. Recommendations are advisory: they may influence ranking, but never grant tool access, bypass approvals, expand write allowlists, disable budget checks or substitute for post-mutation verification.

Learning follows these rules:

- Project observations are visible only to that project; client observations remain inside that client.
- Cross-client signals require an explicitly approved generic namespace and cross-client reuse approval.
- Failed, disputed, stale or poorly validated outcomes must not promote a strategy.
- Human corrections are evidence, but a single correction does not silently become a universal rule.
- Reusable procedural rules should be promoted deliberately and remain versioned/reversible.
- When the learning store is unavailable, planning should continue without learned preferences rather than failing open on permissions or claiming new learning.

## Current implementation and production boundary

The feature branch includes a discoverable capability registry, `CapabilityLearningLoop`, an injectable repository interface, and optional director-context integration. The initial repository implementation is in-memory so the policy and ranking behavior can be tested without external infrastructure.

The production learning ledger is **not yet connected** to Supabase/Postgres. Production wiring still needs a workspace-authorized persistent repository, an authenticated server-side event writer, a migration/retention policy, evidence verification from actual hand execution, and monitoring for noisy or drifting recommendations. The server-owned runtime tool registry remains authoritative for execution permissions and budget reservations.

## Acceptance checks

- A newly registered website/application capability is discoverable by tags and modality without adding planner branches.
- Unavailable, unsupported, unvalidated or disallowed capabilities cannot be executed.
- Learned preferences require repeated validated evidence and are scoped before aggregation.
- Cross-client learning fails closed without explicit approval and licensing.
- Recommendations only refer to capability IDs present in the current candidate set.
- Learning cannot authorize external writes, bypass human approval or permit unreserved paid execution.
- No raw prompts, screenshots, design payloads or private chain-of-thought enter the learning event contract.

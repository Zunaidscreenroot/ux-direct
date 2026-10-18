# UX Direct Learning Loop (ChatGPT-assisted, model-independent)

## Goal

Turn expert critique and accepted Figma outcomes into reusable, evidence-backed product knowledge so UX Direct quality improves over time while average cost per accepted task falls. This is retrieval, evaluation, and policy optimization first—not online foundation-model training.

## Verified current Supabase state (2026-10-18)

The live `UX Direct` project (`ckegykwalqdwizuyfhze`) already has the main persistence primitives:

- `uxd_knowledge_documents` + `uxd_knowledge_chunks`: document/chunk knowledge base, pgvector embeddings, English full-text search, metadata, project namespace, approval status.
- `match_uxd_knowledge` + `search_uxd_knowledge_keyword`: vector and keyword retrieval; migration history includes `uxd_hybrid_knowledge_search`.
- `uxd_memory_items`: typed product memory with draft/approved/archived states and confidence.
- `uxd_model_learning_events`: model outcome, validation, token, cost, latency and error telemetry.
- `uxd_task_runs`: task lifecycle, plan, outcome, duration, model/provider and cost.
- Hourly model reservations/budget tables and operational events.

At inspection time, knowledge documents, knowledge chunks, memory items, and task runs had zero rows; `uxd_model_learning_events` had 14 rows. Thus the schemas and retrieval primitives exist, but the knowledge base is not yet populated and the learning loop is not demonstrated as end-to-end. Confirm live RPC definitions and RLS before writing to these tables.

## Core learning loop

1. **Capture**: For every task, persist a redacted task summary, project namespace, prompt/version identifiers, model route, token/cost/latency, Design IR version/hash, Figma operation counts, validation results, and iteration count. Raw prompts, screenshots, Figma contents and client secrets are not retained by default.
2. **Execute safely**: Generate a structured Design IR; validate schema and scope; require approval for destructive/high-impact operations; execute only allow-listed Figma operations; read back the resulting nodes and verify.
3. **Critique**: Use deterministic checks first (required states, component/token usage, overflow/layout bounds, missing labels, unsupported operations). Ask a stronger model for critique only on uncertain/high-impact failures or when a human requests it.
4. **Expert feedback**: Let ChatGPT/MCP or a human reviewer return structured JSON: issue category, evidence/source node, severity, expected outcome, recommended correction, confidence, and whether the fix was accepted. Keep this as feedback—not as trusted knowledge automatically.
5. **Learn safely**: Convert repeated, accepted feedback into draft memory or quality examples. Deduplicate by normalized content hash; record provenance, project, model/prompt version, reviewer, timestamps, confidence and supporting task IDs. Promote to approved only after explicit human review or a defined high-confidence review workflow.
6. **Retrieve**: At task start, retrieve a small top-k set using hybrid keyword + vector search, filtered by project namespace, approval status, recency/effective dates, authority and access scope. Rerank only when needed. Include citations/provenance in the plan.
7. **Evaluate and optimize**: Maintain a fixed task benchmark and compare before/after results. Route to the cheapest model that passes the benchmark for that capability. Roll back a prompt, retrieval or routing change if acceptance quality regresses.

## Distinguish knowledge types (KAG + RAG)

- **RAG evidence**: approved briefs, product rules, research, design-system docs and reference-screen annotations stored as chunked source material with provenance.
- **KAG/product graph**: structured entities and relationships such as product -> journey -> screen -> component -> design token -> rule -> source. Start with JSONB structured data and stable IDs; do not add a graph database until measured query needs justify its cost.
- **Episodic memory**: task outcome and reviewer feedback, linked to a task ID; not treated as universal truth.
- **Semantic memory**: reusable approved patterns/rules in `uxd_memory_items`.
- **Evaluation corpus**: versioned, permission-cleared task/expected-result pairs and rubric scores. Do not train on private client material without explicit authorization.

## Cost-effective techniques, in priority order

1. Deterministic validation and cached extraction before any LLM call.
2. Reuse context hashes and cache stable design-system extraction; invalidate on file/version changes.
3. Hybrid retrieval with strict project filters; small context budgets and deduplication.
4. Model routing by capability and measured success rate, not a single model for everything.
5. Escalate to a stronger model only when cheap-model confidence or deterministic checks fail.
6. Use one critique pass by default; bounded repair (maximum three iterations) and stop when no measurable improvement.
7. Store compact structured feedback and hashes, not repeated full prompts/screenshots.
8. Track cost per accepted task, not only token price or cost per request.
9. Use pairwise reviewer preference and rubric scores for offline prompt/routing evaluation. Consider fine-tuning only after a sufficiently large, licensed, high-quality dataset proves retrieval/prompting is insufficient.

## Proposed structured feedback contract

```json
{
  "task_id": "uuid",
  "project_key": "allowlisted-project",
  "artifact_version": "design-ir-v1",
  "reviewer_type": "human|chatgpt_mcp|automated",
  "issues": [{
    "category": "requirements|hierarchy|consistency|accessibility|content|layout|interaction|state_coverage|figma_execution",
    "severity": "blocker|major|minor|suggestion",
    "evidence": {"node_id": "optional", "rule_id": "optional", "note": "redacted"},
    "expected_result": "specific acceptance criterion",
    "recommended_change": "bounded change",
    "confidence": 0.0,
    "accepted": false
  }],
  "rubric": {
    "requirement_coverage": 0,
    "product_consistency": 0,
    "usability": 0,
    "accessibility": 0,
    "execution_correctness": 0
  },
  "decision": "accept|revise|reject"
}
```

Scores should use a documented scale (for example 0-4); do not use the illustrative zeros above as actual scores.

## Safety, privacy and tenancy

- Do not expose Supabase service-role credentials to the Figma plugin or browser.
- All writes and vector/keyword RPC calls go through authenticated server routes with schema validation, request limits, project authorization, and rate limits.
- Keep RLS enabled and client table access denied unless a reviewed policy explicitly requires it.
- Enforce project-level retrieval filters in SQL, not only in prompt text.
- Treat retrieved documents and model feedback as untrusted input; never follow instructions embedded in retrieved content.
- Never auto-promote a model's own critique to trusted product rules. Human review or corroborated evidence is required.
- Store only minimal/redacted evidence. Respect client confidentiality, retention, deletion and opt-in requirements.

## Rollout plan

### Stage A — audit and instrument (no live schema mutation)
- Reconcile the live Supabase schema/migrations with repository history; current live tables are not represented by the migration files found on `main`.
- Add task IDs, artifact/version hashes, prompt version, reviewer and acceptance metrics to task logs through server-side APIs.
- Verify existing hybrid-search function permissions, RLS, project isolation and embedding dimensions.
- Seed only approved, permission-cleared design-system and product knowledge.

### Stage B — feedback capture and offline evaluation
- Add a reviewer UI/API for structured critique and accept/reject/correction decisions.
- Build a small benchmark of representative UX tasks and rubric-scored expected outcomes.
- Keep reviewer feedback in a candidate state; deduplicate and show provenance before approval.

### Stage C — retrieval and routing improvements
- Use hybrid retrieval and a small context budget, with query/result caching.
- Add a model-router report based on accepted outcomes, cost, latency and failure category.
- Run A/B or offline comparisons before changing production defaults.

### Stage D — autonomous quality loop
- Add deterministic QA, model critique only for unresolved issues, bounded repairs and post-edit Figma read-back.
- Permit independent mode only when it passes the same benchmark without ChatGPT MCP.
- Disable the temporary MCP adapter after parity is demonstrated.

## Success criteria

Track a baseline and weekly trend for:
- reviewer acceptance rate and rubric score
- requirement/state coverage and post-edit validation pass rate
- manual correction minutes
- successful task completion and Figma operation error rate
- p50/p95 latency
- model + infrastructure cost per accepted task
- percentage of tasks completed without expensive-model escalation
- regression rate after knowledge/prompt/router changes

Do not claim “perfect” behavior; use measurable thresholds, confidence, and human review for consequential design decisions.

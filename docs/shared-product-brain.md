# Shared Product Brain

The Shared Product Brain is a **backend capability**, not a user-facing page. UX Direct owns it. UX Audit, the Figma plugin, and future local models call the same authenticated endpoints and use the same approved memory store.

## Data lanes

- `uxd_brain_feedback`: raw owner correction, original language, normalized rule, rationale, scope, keywords, examples, source product, and review state. New feedback is a draft.
- `uxd_memory_items`: canonical, approved operational memory—design principles, reusable interaction patterns, product standards, workflow rules, cost constraints, and validated lessons.
- `uxd_knowledge_documents` + `uxd_knowledge_chunks`: curated references split into searchable chunks. Documents remain excluded until approved.
- `uxd_brain_eval_cases`: deterministic regression cases for retrieval recall and forbidden-context checks.

Client audit results remain in each product's own **Past Findings** data. Do not bulk-copy findings, screenshots, or client reports into the cross-product brain. A client-specific observation can be cited as feedback context, but it becomes shared guidance only after it is distilled into a generalizable rule and approved.

## Memory scopes

Every retrieval request passes explicit allow-listed scopes. Current scopes include:

- `UX_SHARED_BRAIN`: general reusable product and design principles.
- `indian-bfsi`: Indian Banking, Financial Services and Insurance standards.
- `project:ux-direct`, `project:ux-audit`: product-specific operating rules.
- `project:dmi-finance`, `project:ujjivan-sfb`, `project:express-computers`: narrowly scoped project guidance.

The reader must not automatically add a client scope just because a client name appears in the query.

## Learning cycle

1. The owner explains naturally—in Hindi, Hinglish, English, voice or text—what was wrong and what better behavior is expected.
2. ChatGPT interprets the feedback and writes a short English rule while preserving the original words and language. It also records correction type, reason, scope and any compact before/after example.
3. The feedback is saved as a draft in the shared brain. No model inference is needed to store it.
4. Only an explicit owner approval promotes it into `uxd_memory_items`. Reject/archive operations keep incorrect or stale rules out of retrieval.
5. UX Direct planning and UX Audit retrieval select only relevant approved items. Current request/screenshot evidence still takes precedence.
6. Add regression cases for mistakes that must not recur; run them using Postgres retrieval only, with no paid model calls.

## Cost and latency rules

- Use Postgres full-text search, tags/title matching and scope filters first. It is deterministic and does not require a separate embedding API call.
- Fetch a small top-K result set, not the whole memory library.
- Bound model context. Current planner retrieval caps context at 3,200 characters; UX Audit uses a separate compact budget and includes its local history in a clearly labelled section.
- Ingest references as chunks once, not on every question.
- Use content hashes and idempotency keys to prevent duplicate feedback ingestion.
- Do not run an LLM to rewrite or consolidate memory on every request. Extract the rule during owner coaching, then review it. More expensive semantic/vector retrieval can be introduced if evaluations show full-text retrieval missing meaningful results.
- Keep the model provider interchangeable. Memory APIs do not depend on model vendor or model weights.

## Local-model compatibility

Ollama/llama.cpp or another OpenAI-compatible local model can use the same context payload from the shared brain. Moving to a local model changes the provider configuration; it does not require rebuilding or fine-tuning the memory database from scratch. The local model still needs suitable prompt following and task capability, and retrieval should be measured against the same evaluation cases.

## Security and quality

- Brain APIs require server-to-server Bearer authentication and must not be called with secrets from browser code.
- Only approved memories and approved documents are returned.
- Feedback and reference insertion are draft-only; approval is a separate action.
- Reference content is context, never an instruction that can override policy or the current task.
- Do not treat model-generated audit findings as objective truth. Use owner feedback and evaluation results to correct failure patterns.
- Keep client data, shared reusable lessons, and public/official reference material as distinguishable sources.

## Concepts adapted

The design follows the useful ideas—not a new runtime dependency—from:
- [Mem0](https://github.com/mem0ai/mem0): selective long-term memory and multi-signal retrieval.
- [LangMem](https://github.com/langchain-ai/langmem): hot-path memory tools, consolidation, and reviewable memory lifecycle.
- [pgvector](https://github.com/pgvector/pgvector): PostgreSQL-native vector search when evaluations justify semantic retrieval.
- [agent-memory-toolkit](https://github.com/autosre-ai/agentmemory): hybrid retrieval and explicit memory tiers.

These projects are research references. This implementation uses the existing TypeScript + Neon Postgres stack, with Cloudflare R2 for large binary assets such as screenshots. The shared brain remains model-independent and does not introduce a separate Python memory service or new recurring hosting costs.

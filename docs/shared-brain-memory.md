# UX Shared Brain

The UX Shared Brain is a **backend service**, owned by UX Direct and shared by UX Direct, UX Audit and the Figma plugin. Coaching is an internal workflow: ChatGPT interprets a user's natural-language or voice correction and calls the MCP memory tools. The user should never have to write a memory template.

## Keep three stores distinct

1. **Past findings** (audit_clients, audits, audit_pages, audit_findings): client-specific audit reports and screenshots. They can be retrieved as historical examples, but must not be promoted automatically to reusable product knowledge.
2. **Knowledge base** (uxd_knowledge_documents, uxd_knowledge_chunks): curated, source-backed design standards, accessibility guidance, research, regulatory summaries and approved references. Documents retain source URL, authority, verification/effective dates, version and scope.
3. **Product memory** (uxd_memory_items, uxd_brain_feedback): approved reusable lessons, decisions, patterns, tool-routing hints and failure/correction rules. The feedback row retains the original Hindi/Hinglish/English correction separately from the normalized, concise rule.

## Learning lifecycle

1. User explains a correction naturally, including through a ChatGPT voice transcript.
2. ChatGPT classifies it, preserves the original feedback, writes a concise rule/rationale, suggests the narrowest scope and may attach a short calibration example or audit/finding reference.
3. The backend saves a **draft**. It is not retrieved by normal audits until explicitly approved.
4. Approval promotes the associated memory item; rejection/archive removes it from active recall. A later correction should archive or supersede a stale rule, not stack contradictory prompt text.
5. Audits and Figma/UX Direct tasks retrieve a small, relevant set of approved items. Current screen evidence always outranks memory. Historical client findings remain separately labeled examples.

## Retrieval and token control

- **Namespaces/scopes:** UX_SHARED_BRAIN, UX_DIRECT, UX_AUDIT, EXPRESS_COMPUTERS, DMI_HFC, UJJIVAN_SFB, INDIA_BFCI_SHARED. Every retrieval includes shared global rules plus only the requested product/domain scope.
- **Hybrid search:** Postgres full-text search is always available. Optional pgvector similarity search is added when an embedding provider is configured; keyword/vector result lists use Reciprocal Rank Fusion (RRF). No embedding API is required to run the initial keyword-only brain.
- **Provenance and freshness:** source product, source reference, source URL/authority, confidence, validity windows, version/effective dates and usage telemetry support review, expiry and supersession.
- **Deduplication:** normalized rule hashes and unique idempotency keys reduce repeated memory writes.
- **Bounded context:** the service caps returned results and characters; consumers request 2,400–3,000 characters rather than passing the full database or old chats into every model call.
- **No model lock-in:** embedding and model providers are configuration-driven. A local Ollama/OpenAI-compatible endpoint can later replace remote providers without changing memory storage or scopes.

## Evaluation and improvement

uxd_brain_eval_cases stores approved retrieval golden cases. The backend runner measures expected-memory recall@K, forbidden-context hits and context size without making a paid generation call. Expand the cases whenever an important false positive, missed issue, scope-leak or regression is corrected. Pair retrieval metrics with audit quality checks (evidence linkage, duplicate rate, severity calibration, recommendation specificity and reviewer acceptance); do not equate high retrieval recall with accurate auditing.

## Open-source concepts evaluated

- [Mem0](https://github.com/mem0ai/mem0): long-term memory extraction, update/merge and memory-management patterns. We reuse the general design concepts while retaining Supabase as the system of record.
- [Graphiti](https://github.com/getzep/graphiti): provenance, temporal facts and hybrid retrieval. A graph database would add operational cost now, so the initial implementation uses existing Postgres/pgvector and temporal columns.
- [LangGraph long-term memory](https://docs.langchain.com/oss/javascript/langgraph/add-memory): scoped namespaces and persistent stores. We apply namespaces without introducing a new orchestration framework.
- [Supabase hybrid search](https://supabase.com/docs/guides/ai/hybrid-search): Postgres full-text + pgvector retrieval with RRF.
- Internal [figma-design-agent evaluation material](https://github.com/Zunaidscreenroot/figma-design-agent): retain the evaluation-first approach without making UX Direct depend on the separate agent repository.

## Current implementation boundary

This is persistent external memory and retrieval—not model-weight fine-tuning. It can reduce repeated explanations and irrelevant prompt history, but retrieved context itself consumes tokens and does not guarantee perfect output. The first deployment should be validated with actual owner corrections and following audits before making quantitative claims about saved tokens or accuracy.

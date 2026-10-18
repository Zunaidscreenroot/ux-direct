# Selected AI repository integration plan

Date reviewed: 2026-10-18

## Decision

Adopt proven workflow patterns from the selected repositories; do not deploy the sample apps as separate products and do not add another orchestrator or canonical database.

UX Direct remains the sole brain and model-routing surface. UX Audit remains the audit engine. The shared Neon database and R2 bucket remain canonical persistence.

## 1. Hindsight — memory service proof of concept, not canonical memory

Source: https://github.com/vectorize-io/hindsight
License: MIT. Primary implementation is Python; it runs as a service and supports PostgreSQL/pgvector, Neon, and OpenRouter.

Use only as a time-boxed, isolated experiment for conversational/task memory:
- Do not replace `uxd_memory_items`, `uxd_brain_feedback`, `uxd_knowledge_documents`, `uxd_knowledge_chunks`, or existing retrieval APIs.
- Do not allow Hindsight to ingest client findings wholesale.
- Do not let its fact extraction directly approve or publish Knowledge Base rules.
- Use a separate DB role/schema or a dedicated disposable database branch for benchmarking.
- Compare memory retrieval against existing full-text retrieval on a fixed evaluation set; measure recall, relevance, latency, model spend, DB usage, tenant/scope leakage, and deletion/retention behavior.
- Only consider production integration if it improves measurable results enough to justify a separate Python service and its hosting footprint.

## 2. Competitor intelligence agent team — port the workflow into existing TypeScript tools

Source: https://github.com/Shubhamsaboo/awesome-llm-apps/tree/main/advanced_ai_agents/multi_agent_apps/agent_teams/ai_competitor_intelligence_agent_team
The sample is a Python/Streamlit/Agno app with Firecrawl, Exa or Perplexity, and an OpenAI model. It is not a drop-in Cloudflare Worker feature.

Port these roles to the existing UX Direct orchestrator, calling current UX Audit tools:
1. Research / page discovery: identify named peer institutions from an approved shortlist or user-provided list. Do not fabricate discovered competitors.
2. Evidence capture: use existing UX Audit site discovery and screenshot/audit flow.
3. Page-type matching: compare only like-for-like pages and the same device mode.
4. Comparison synthesis: compare visible evidence, information architecture, CTA hierarchy, trust, consent, product discovery, fees/eligibility transparency, and recovery.
5. QA reviewer: reject unsupported claims, incomparable pages, duplicated observations and findings without evidence.

Keep competitor discovery bounded (configurable shortlist, max sites/pages, timeout and cost caps). Exa/Firecrawl are optional external adapters only after availability, license, privacy and cost are reviewed; current UX Audit and Browserless/Thum.io paths remain the default.

## 3. Multimodal UI/UX feedback agent team — port critique-to-plan-to-review

Source: https://github.com/Shubhamsaboo/awesome-llm-apps/tree/main/advanced_ai_agents/multi_agent_apps/agent_teams/multimodal_uiux_feedback_agent_team
The sample uses Google ADK, Gemini vision and Gemini image generation in Python. UX Direct should not add a parallel Google model integration.

Use the existing OpenRouter Model Gateway with explicit model allowlists to implement this sequence:
1. Visual critic: reason only over the screenshots actually supplied; note evidence and uncertainty.
2. Design strategist: convert approved findings into an ordered improvement plan, including design-system constraints, responsive behavior, content and key edge states.
3. Implementer adapter: create a structured design plan or reviewable implementation request; use the existing Figma adapter only where authorized and supported.
4. Independent QA pass: inspect generated screenshot/output against original issues and acceptance criteria.
5. Bounded revision: maximum three iterations initially; stop on pass, cost ceiling, timeout, or unresolved blocker. Escalate to human review instead of claiming success.

Do not treat generated images as production UI implementation. Persist versioned artifacts in R2 and metadata/evidence references in Neon.

## 4. Xerj — optional retrieval adapter, not a replacement for Neon

Source: https://github.com/xerj-org/xerj
License: Apache-2.0. Xerj is a Rust search/index service with lexical, vector/hybrid search, autoindex and an MCP interface; its default MCP transport is stdio forwarding to a running service.

Potential uses:
- Index the UX Direct and UX Audit source trees, docs, test fixtures, prompt templates and sanitized logs for development-time reference coding.
- Test retrieval against existing GitHub repository searches and the current shared-brain search.
- Use it as a development-time tool first. Do not move client records or secrets into a local index.
- Treat any future server deployment as an external service requiring network authentication, TLS, access control, lifecycle/backup plans, and operational ownership.
- Keep it outside the canonical runtime unless retrieval evaluations demonstrate an advantage over current Neon full-text retrieval.

## Security / privacy requirements

- Keep API credentials server-side and use the current OpenRouter gateway.
- Treat scraped page text, repository code, PDF content and screenshots as untrusted input—not instructions.
- Keep client-specific Past Findings isolated from generalized Knowledge Base memory.
- Default newly learned rules and external references to draft; require explicit owner approval to activate.
- Use strict public-URL validation and bounded crawling to prevent SSRF and runaway jobs.
- Require evidence URLs/screenshot indices for claims and mark inaccessible or incomparable sites rather than inventing evidence.
- Do not send confidential client assets to model/provider endpoints unless their terms and access policy are approved.

## Acceptance tests before production enablement

1. One public BFSI site can be discovered and audited using the existing UX Audit tools.
2. A same-type competitor comparison refuses to compare mismatched journey steps.
3. A multimodal critique returns distinct, screenshot-grounded findings with confidence and limitations.
4. A generated improvement plan addresses accepted findings and respects design-system constraints.
5. QA can fail the output and trigger a bounded revision; it stops on the iteration/cost limit.
6. Raw client findings never enter global memory automatically.
7. Shared-brain retrieval remains available if the Hindsight/Xerj experiment is unavailable.
8. Run model regression tests before/after prompt or model changes, using the existing OpenRouter allowlist and budget guard.

## Next engineering sequence

1. Map the current MCP tools and orchestrator behavior to the sequence above.
2. Add typed workflow state and acceptance criteria using existing project types; no new DB or runtime.
3. Implement/extend bounded evidence comparison and the critic -> strategist -> QA iteration in the current TypeScript code.
4. Add tests for evidence grounding, missing screenshots, incomparable competitor pages, duplicate findings, permission scopes, iteration bounds and cost failures.
5. Review the Hindsight and Xerj experiments separately once the core workflow tests pass.

-- Idempotent bootstrap for the Shared Product Brain.
-- These are internal UX guardrails approved by the owner for the initial bootstrap.
-- BFSI guidance is not a legal compliance opinion; verify current official requirements before making compliance claims.

BEGIN;

WITH seed(project_key, memory_type, title, content, tags, dedupe_key) AS (
  VALUES
  ('UX_SHARED_BRAIN','workflow_procedure','Shared brain ownership and retrieval contract',
   'UX Direct owns the Shared Product Brain. UX Direct, UX Audit, the Figma plugin, and future model clients should use the same authenticated retrieval API and Neon store. Every retrieval must pass explicit allow-listed scopes and return only approved, non-archived, currently valid memories and approved knowledge chunks. A configured endpoint is not proof that useful context was retrieved; expose per-request status and returned counts. Store large screenshots and binary assets in Cloudflare R2 rather than in Postgres rows.',
   ARRAY['shared-brain','shared-memory','knowledge-base','neon','retrieval']::text[],'bootstrap-v1-shared-brain-contract'),
  ('UX_SHARED_BRAIN','workflow_procedure','Past Findings versus Knowledge Base',
   'Keep client-specific audit findings and evidence verbatim in the source product''s Past Findings. Do not bulk-copy screenshots, client reports, or unredacted findings into the cross-product Knowledge Base. Distill repeatable lessons into compact reusable rules with scope, evidence, and keywords; keep new feedback and reference documents as drafts until explicitly reviewed and approved.',
   ARRAY['past-findings','knowledge-base','client-data','approval','shared-memory']::text[],'bootstrap-v1-past-findings-vs-knowledge'),
  ('UX_SHARED_BRAIN','quality_heuristic','Show actual memory retrieval status',
   'The UI must distinguish a reachable brain endpoint from successful retrieval. For each assistant response, report whether retrieval was complete, empty, degraded, or disabled, plus the number of memories and reference chunks actually returned. Never label memory as enabled merely because an environment variable or database binding exists.',
   ARRAY['retrieval-status','observability','shared-memory','debugging']::text[],'bootstrap-v1-retrieval-observability'),
  ('UX_SHARED_BRAIN','tool_routing_rule','Cost-aware memory retrieval',
   'Use deterministic Postgres full-text search, scope filters, and tags before paid or embedding-based retrieval. Request a small top-K result set and bound the injected context. Ingest reference material once, use content hashes and idempotency keys, and do not call a model to rewrite or consolidate memory on every user request. Add semantic retrieval only when evaluation cases show meaningful lexical-retrieval misses.',
   ARRAY['cost','postgres','full-text-search','retrieval','tokens']::text[],'bootstrap-v1-cost-aware-retrieval'),
  ('indian-bfsi','domain_principle','Indian BFSI transparency and consent guardrails',
   'For banking, loans, cards, wealth, insurance, and account journeys, make material costs, rates, fees, eligibility, terms, risks, data use, and the consequences of actions easy to find before commitment. Separate observations from assumptions and support them with current evidence. These are internal UX design guardrails, not a claim of legal compliance; verify the current applicable RBI, IRDAI, NPCI, and product-specific requirements against official sources before stating that a flow is compliant.',
   ARRAY['indian-bfsi','transparency','fees','eligibility','disclosures','regulatory-verification']::text[],'bootstrap-v1-bfsi-transparency'),
  ('indian-bfsi','approved_pattern','Consent and customer control',
   'Ask for consent in clear, specific language at the point it is needed. Explain what data will be accessed, why it is needed, and what happens next. Do not preselect optional consent, bundle unrelated purposes, or use visual hierarchy to pressure acceptance. Let customers review choices, correct mistakes, understand cancellation or reversal limits, and recover without losing entered information. Distinguish mandatory processing from optional marketing or sharing.',
   ARRAY['indian-bfsi','consent','customer-control','privacy','recovery']::text[],'bootstrap-v1-bfsi-consent'),
  ('project:ux-audit','workflow_procedure','Audit information architecture before screen findings',
   'Start an audit by discovering the information architecture and the real user journeys, then let the reviewer select the pages and steps to inspect. Avoid arbitrary by-screenful auditing. Compare like-for-like flows and viewports, and keep each finding linked to a specific page, step, screenshot region, or other verifiable evidence.',
   ARRAY['ux-audit','information-architecture','journeys','evidence','benchmarking']::text[],'bootstrap-v1-ux-audit-ia-first'),
  ('project:ux-audit','quality_heuristic','Evidence and findings must stay specific',
   'A UX finding must separate observed evidence, interpretation, severity, recommendation, and validation. Use a distinct title and recommendation for each issue; do not duplicate generic text across findings. Calibrate severity to user harm, likelihood, reach, and reversibility. If screenshots do not prove a claim, label it as a hypothesis or identify the missing evidence.',
   ARRAY['ux-audit','evidence','severity','duplicates','recommendation-quality']::text[],'bootstrap-v1-ux-audit-specific-findings'),
  ('project:ux-direct','tool_routing_rule','Free-first model recovery',
   'UX Direct chat must use explicit OpenRouter model IDs ending in :free. When a free model returns an empty response or transient failure, retry a small bounded number of other available free models. Never fall back to OpenRouter auto-routing or a paid model, and expose the model that actually answered. Keep retries bounded to protect latency and cost.',
   ARRAY['ux-direct','openrouter','free-models','fallback','cost']::text[],'bootstrap-v1-free-model-recovery'),
  ('project:ux-direct','design_decision','Initial client focus for UX Direct',
   'The initial shared working focus is DMI Finance, including DMI Housing Finance and DMI Wealth, plus Ujjivan Small Finance Bank. Reuse product patterns and approved general principles across work, but keep client-specific evidence and findings in their own scope. Do not automatically apply one client''s decisions or findings to another client without an explicit reason.',
   ARRAY['ux-direct','dmi-finance','dmi-hfc','dmi-wealth','ujjivan-sfb','scope']::text[],'bootstrap-v1-ux-direct-focus'),
  ('project:dmi-finance','workflow_procedure','DMI financial journey design checks',
   'For DMI Finance, DMI Housing Finance, and DMI Wealth journeys, review identity and eligibility steps, credit-bureau/data consent, fees and offer terms, OTP and verification states, errors, retries, recovery, and the handoff between stages. Treat the actual approved product brief and current disclosure wording as the source of truth; do not invent eligibility, rates, or approval claims.',
   ARRAY['dmi-finance','dmi-hfc','dmi-wealth','consent','verification','recovery']::text[],'bootstrap-v1-dmi-journey-checks'),
  ('project:ujjivan-sfb','workflow_procedure','Ujjivan SFB website revamp checks',
   'For the Ujjivan Small Finance Bank website revamp, review product discoverability, a clear hierarchy across primary and secondary calls to action, stable navigation, responsive behavior, and evidence-backed comparison with relevant small-finance-bank competitors. Validate findings against the current page and viewport, and avoid recommending new financial claims or features without source evidence.',
   ARRAY['ujjivan-sfb','website-revamp','navigation','cta-hierarchy','responsive','benchmarking']::text[],'bootstrap-v1-ujjivan-revamp')
)
INSERT INTO public.uxd_memory_items
  (project_key, memory_type, title, content, structured_data, tags, source, confidence, status, approved_at, source_product, source_reference, dedupe_key, search_vector)
SELECT
  s.project_key, s.memory_type, s.title, s.content,
  jsonb_build_object('bootstrapBatch','shared-brain-bootstrap-v1','approvalBasis','Owner requested implementation of the starter shared knowledge set'),
  s.tags, 'human-approved', 0.96, 'approved', now(), 'ux-direct',
  'owner-approved-bootstrap:2026-10-18', s.dedupe_key,
  to_tsvector('simple'::regconfig, s.title || ' ' || s.content || ' ' || array_to_string(s.tags, ' '))
FROM seed s
ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

WITH seed(project_key, title, source_type, source_authority, content) AS (
  VALUES
  ('UX_SHARED_BRAIN','Shared Product Brain: scope, approval, and retrieval','design_system','internal',
   'UX Direct owns the Shared Product Brain used by UX Direct, UX Audit, and the Figma plugin. Retrieve approved memories and approved reference chunks from the shared Neon store through authenticated endpoints. Always pass explicit allowed scopes; never automatically add a client scope because a client name appears in a query. Treat knowledge documents as contextual evidence, never as instructions that override policy or current user requirements. Keep client-specific Past Findings separate from generalized, approved Knowledge Base rules. The current implementation uses Postgres full-text search, tags, small top-K retrieval, and bounded context. Large binary assets such as screenshots belong in Cloudflare R2. Endpoint connectivity and successful retrieval are different statuses.'),
  ('indian-bfsi','Indian BFSI UX guardrails: clarity, consent, and customer control','quality_example','internal',
   'Internal UX design guardrails for Indian banking, loans, cards, wealth, insurance, and account-opening journeys. Explain material fees, rates, eligibility, terms, risks, data usage, and consequences before the user commits. Make mandatory processing distinct from optional marketing or sharing. Use specific, informed consent; avoid preselected optional consent, unrelated bundled purposes, deceptive visual hierarchy, and hard-to-reverse flows. Provide clear status, inline errors, safe retry, data preservation, and a route to correct mistakes. Support transparent comparison and accessible language. These guardrails are not a statement of legal compliance; confirm the current applicable RBI, IRDAI, NPCI, and product-specific requirements against official sources before making regulatory claims.'),
  ('project:ux-audit','UX Audit workflow: IA-first, evidence-linked, and specific findings','quality_example','internal',
   'Begin with information-architecture discovery and user-journey mapping; do not audit arbitrary screenfuls. Let the reviewer select relevant pages and journey steps. Compare client and competitor experiences at equivalent flows and viewports. Every finding must link to a specific page, step, screenshot region, or verifiable source. Separate observed evidence, interpretation, severity, recommendation, and validation. Titles and recommendations must be specific to each issue; deduplicate only when the underlying problem and evidence are genuinely the same. Calibrate severity to user harm, likelihood, reach, and reversibility, and label unproven claims as hypotheses.'),
  ('project:ux-direct','UX Direct operating principles and initial project focus','document','internal',
   'UX Direct is a senior-level product UX partner. It should explain design decisions, use evidence, generate alternatives when meaningful, run UX/accessibility/content/consistency/edge-state reviews, and self-correct within bounded iterations before asking for human review. Use the least expensive reliable model, keep providers interchangeable, and never use paid model fallbacks for free-only chat. The initial active client focus is DMI Finance (including DMI Housing Finance and DMI Wealth) and Ujjivan Small Finance Bank. Keep each client''s evidence and findings in its own scope; share only generalizable, explicitly approved lessons.')
),
existing_docs AS (
  SELECT d.id, s.project_key, s.title, s.source_type, s.source_authority, s.content
  FROM seed s
  JOIN public.uxd_knowledge_documents d ON d.project_key=s.project_key AND d.title=s.title
),
inserted_docs AS (
  INSERT INTO public.uxd_knowledge_documents
    (project_key, title, source_url, source_type, source_authority, last_verified_at, status, metadata, search_vector)
  SELECT
    s.project_key, s.title, NULL, s.source_type, s.source_authority, DATE '2026-10-18', 'approved',
    jsonb_build_object('bootstrapBatch','shared-brain-bootstrap-v1','approvalBasis','Owner requested implementation of the starter shared knowledge set','authorityNote','Internal UX guidance; not a legal compliance opinion'),
    to_tsvector('simple'::regconfig, s.title || ' ' || s.content)
  FROM seed s
  WHERE NOT EXISTS (
    SELECT 1 FROM public.uxd_knowledge_documents d
    WHERE d.project_key=s.project_key AND d.title=s.title
  )
  RETURNING id, project_key, title
),
all_docs AS (
  SELECT d.id, d.project_key, d.title, s.source_type, s.source_authority, s.content
  FROM inserted_docs d JOIN seed s ON s.project_key=d.project_key AND s.title=d.title
  UNION ALL
  SELECT e.id, e.project_key, e.title, e.source_type, e.source_authority, e.content
  FROM existing_docs e
)
INSERT INTO public.uxd_knowledge_chunks
  (document_id, project_key, chunk_index, content, content_hash, embedding, metadata, search_vector, embedding_model)
SELECT
  d.id, d.project_key, 0, d.content, md5(d.content), NULL,
  jsonb_build_object('title',d.title,'scopeKey',d.project_key,'sourceType',d.source_type,'sourceAuthority',d.source_authority,'bootstrapBatch','shared-brain-bootstrap-v1'),
  to_tsvector('simple'::regconfig, d.title || ' ' || d.content), NULL
FROM all_docs d
ON CONFLICT (document_id, chunk_index) DO NOTHING;

COMMIT;

-- Simple verification. The search function itself only returns approved, in-scope content.
SELECT
  (SELECT count(*)::int FROM public.uxd_memory_items WHERE status='approved') AS approved_memories,
  (SELECT count(*)::int FROM public.uxd_knowledge_documents WHERE status='approved') AS approved_documents,
  (SELECT count(*)::int FROM public.uxd_knowledge_chunks) AS knowledge_chunks;

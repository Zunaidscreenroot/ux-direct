# UX Direct knowledge RAG: source collection and ingestion

## Scope

Only ingest:
- **DMI**: the single umbrella project covering DMI Finance, DMI Wealth, and DMI Housing Finance. The current database retains the compatible internal namespace `DMI_HFC`; ingestion accepts `DMI` and maps it to that namespace.
- **UJJIVAN_SFB**: Ujjivan Small Finance Bank discovery, approved product material, journeys and decisions.
- **INDIA_BFCI_SHARED**: reusable official Indian BFCI guidance shared by those two client projects; this is a shared knowledge scope, not a third client project.

The search function never retrieves one client's namespace for the other. Project documents must be approved before retrieval.

## What to collect

1. Current project brief and requirements, with date/version and owner.
2. Approved journey maps and edge cases: entry points, success, failure, retry, abandonment, handoff and recovery.
3. Reference Figma screens with notes on what is reusable and what is client-specific.
4. Approved/rejected design decisions with the reviewer's rationale.
5. Design-system tokens and component rules, including empty/loading/error/disabled states.
6. Current official RBI, UIDAI and NPCI sources relevant to the active journey, with source URL, effective date and last-checked date.
7. Quality examples: output, reviewer correction, final approved output, and why it was better.

Do not ingest real customer identifiers, PAN/Aadhaar numbers, account details, secrets, or unredacted customer screenshots. Redact sensitive content before ingestion.

## Retrieval and context assembly

UX Direct uses **hybrid RAG + bounded context augmentation**. It keeps embeddings enabled, and it does not fine-tune a model.

1. The ingestion endpoint splits approved or draft source text into overlapping chunks, calls OpenRouter's **openai/text-embedding-3-small** embeddings endpoint, and stores 1,536-dimensional vectors in Supabase pgvector. DMI Finance, DMI Wealth, and DMI Housing Finance all use the same DMI project scope.
2. For a task, UX Direct runs semantic vector search and indexed PostgreSQL full-text search in parallel. Reciprocal-rank fusion merges duplicate hits and promotes evidence found by both routes. If the embedding provider is unavailable or the embedding budget is blocked, keyword results can still be used.
3. Retrieval is restricted to the explicitly selected client namespace plus approved shared BFCI knowledge. The prompt never selects a client from arbitrary prompt-text mentions.
4. A context-assembly layer combines current task requirements, the selected Figma frame, approved source passages and secondary historical learning patterns. It deduplicates and bounds supplemental context so a large repository is not blindly copied into every model call.
5. Retrieved source text is treated as evidence—not as instructions. Important claims should retain a title/URL; regulatory or product gaps must be flagged rather than invented.

Embeddings are generated automatically; there is no manual embedding work. Identical queries can reuse a short-lived in-memory retrieval cache within each server instance.

## Before importing the company knowledge base

For web research, provide topic names, target websites or official source URLs. Research notes should be curated and attributed with source URL, publication/effective date, and last-checked date; do not copy entire websites. For company material, provide an approved export or authorized text from briefs, journeys, research, design decisions, and design-system guidance. Keep client-specific information in that client's namespace and mark reusable BFCI material explicitly as approved for sharing.

Use **draft** status initially. Promote an item to **approved** only after an authorized owner confirms its accuracy, confidentiality, reuse permission, and date/version. Never upload customer PII, credentials, or unredacted customer screenshots.

## Configure ingestion

Set **UXD_RAG_INGEST_KEY** as a server-only Sensitive environment variable in the Vercel deployment that hosts UX Direct. Reuse the existing server-side **OPENROUTER_API_KEY** and **SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY** (or supported Supabase secret key). Never expose these values in the plugin UI or a NEXT_PUBLIC_ variable.

After deployment, send a JSON POST to **/api/knowledge/ingest** with header **x-uxd-ingest-key**. Example:

~~~bash
curl -X POST "$UX_DIRECT_URL/api/knowledge/ingest" \
  -H "Content-Type: application/json" \
  -H "x-uxd-ingest-key: $UXD_RAG_INGEST_KEY" \
  --data-binary @knowledge-source.json
~~~

Example knowledge-source.json:

~~~json
{
  "projectKey": "DMI",
  "title": "DMI VKYC recovery requirements",
  "sourceUrl": "https://approved-internal-source.example/path",
  "sourceType": "brief",
  "sourceAuthority": "client-approved",
  "publishedAt": "2026-10-01",
  "effectiveAt": "2026-10-01",
  "lastVerifiedAt": "2026-10-14",
  "versionLabel": "v1.0",
  "status": "draft",
  "metadata": {
    "journey": "VKYC",
    "owner": "Product/UX",
    "tags": ["verification", "recovery"]
  },
  "content": "Paste approved, redacted text extracted from the source document here. The endpoint chunks this text and generates embeddings automatically."
}
~~~

Use status "draft" while collecting/reviewing material. Use status "approved" only when the content is approved and safe to use in design decisions. Archived or draft documents are not retrieved.

## Cost and quality controls

- The same rolling ₹50/24-hour server-side budget guard covers paid chat, explicit paid model tests and embedding calls.
- Embedding batches are capped and costed before each provider call.
- Hybrid retrieval fuses up to six semantic and six keyword candidates, removes duplicates, and sends at most four short passages to the model.
- Supplemental approved knowledge is capped at 6,400 characters and historical learning at 2,000 characters, in addition to the task/screen context.
- Every chunk retains document provenance, project namespace, source authority, URL, version metadata and a content hash.
- RAG retrieval is best-effort: if the vector store or embedding API is unavailable, free chat can continue without retrieved context.
- Before using regulatory material, verify its current effective date and official source. RAG results are evidence, not compliance certification.

## Current state

The Supabase tables and search RPC are installed. The secured ingestion endpoint and project-aware retrieval are implemented in the code branch. No internal client briefs have been ingested yet; the knowledge tables are currently empty, so retrieval will return no project passages until source material is uploaded and approved.

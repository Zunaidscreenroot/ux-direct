# UX Direct knowledge RAG: source collection and ingestion

## Scope

Only ingest:
- **DMI_HFC**: approved DMI Housing Finance briefs, journeys, reference screens, decisions and design-system rules.
- **UJJIVAN_SFB**: Ujjivan Small Finance Bank discovery, approved product material, journeys and decisions.
- **INDIA_BFCI_SHARED**: official Indian BFCI rules/guidance that directly supports those two projects.

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

## How embeddings work

The ingestion endpoint splits text into overlapping chunks, calls OpenRouter's **openai/text-embedding-3-small** embeddings endpoint, and stores 1,536-dimensional vectors in Supabase pgvector. The assistant embeds the user's current task, searches only the active project plus shared BFCI sources, and adds a small set of source-cited passages to the prompt.

This is RAG, not model fine-tuning. We do not need to train an embedding model. Embeddings are generated automatically on ingestion and cached for repeated identical queries for five minutes within a server instance.

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
  "projectKey": "DMI_HFC",
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
- Retrieval returns at most four short passages to limit prompt-token growth.
- Every chunk retains document provenance, project namespace, source authority, URL, version metadata and a content hash.
- RAG retrieval is best-effort: if the vector store or embedding API is unavailable, free chat can continue without retrieved context.
- Before using regulatory material, verify its current effective date and official source. RAG results are evidence, not compliance certification.

## Current state

The Supabase tables and search RPC are installed. The secured ingestion endpoint and project-aware retrieval are implemented in the code branch. No internal client briefs have been ingested yet; the knowledge tables are currently empty, so retrieval will return no project passages until source material is uploaded and approved.

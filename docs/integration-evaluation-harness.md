# Agent workflow integration evaluation cases

This document defines low-cost regression tests for the workflows adapted from selected AI repository examples. These tests must run with deterministic fixtures/mock providers first; they must not call paid models automatically.

## UI/UX critique
- Finding is tied to a supplied screenshot index.
- Every issue has a distinct title, visual evidence, impact, recommendation, and confidence.
- Missing or low-quality evidence produces a limitation, not a fabricated finding.
- Two descriptions of the same issue in the same region are deduplicated.
- Major/critical findings have a rationale tied to user goal impact.
- Positive findings are emitted only when supported by clear evidence.

## Competitor intelligence
- Comparison is limited to user-selected or explicitly approved peers.
- A competitor's feature cannot be asserted unless the supplied evidence shows it.
- Page types and device modes must match before relative-position judgments.
- If page types are not comparable, output `not-comparable`.
- Site capture denial, timeout, or empty content is reported as a capture failure, never as a UX defect.
- The site/page budget, concurrency, timeouts, and request spend ceiling are enforced.

## Improvement and QA loop
- Design plan maps each accepted high-impact finding to a proposed change.
- Plan preserves confirmed product patterns and design-system constraints.
- Plans include applicable mobile behavior, content, accessibility, and recovery/edge states.
- Independent QA compares output against original requirements, findings, and screenshots.
- Revision stops after a maximum of three iterations, on a budget ceiling, or on an unresolved blocker.
- The agent never reports that code/Figma changes were applied unless the underlying executor confirms and verifies them.

## Memory and retrieval
- Existing shared-brain search continues to work with Hindsight or Xerj unavailable.
- Only scoped, approved Knowledge Base records are included in default retrieval.
- Past Findings remain client-scoped and are not copied to shared memory by background processing.
- Draft feedback does not influence audit prompts until explicit owner approval.
- Memory retrieval result reports source and scope metadata; conflicting evidence is surfaced.

## Optional search experiments
- Evaluate Hindsight retrieval against fixed existing query/expected-document pairs.
- Evaluate Xerj against a representative sanitized corpus of code/docs/prompts and known answer passages.
- Compare recall@k, precision of cited passages, latency, total model tokens, operational cost, data-boundary behavior, and deletion semantics.
- Do not enable an optional external memory/search service in production based on star count or a single qualitative demo.

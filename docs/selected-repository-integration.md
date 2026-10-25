# UX Direct selected repository integration

This implementation keeps the existing UX Direct model gateway, shared brain and screenshot services. Selected repositories are used as focused adapters or references, not as replacements for product-specific reasoning.

## Runtime integrations

- React Flow / xyflow (MIT): interactive IA map at /ia-demo.
- IA discovery: the deployed Cloudflare Worker uses a bounded, same-origin fetch crawler with a queue, deduplication, depth/page caps, retries and lightweight page extraction. These follow useful Crawlee patterns while avoiding a Node.js crawling runtime inside the Worker.
- Crawlee: scripts/ia-crawl.mjs is an optional actual @crawlee/cheerio crawler for a Node.js environment. It does not use Playwright or Puppeteer and is not imported into the Worker bundle.
- UX audit mechanics: src/ux-audit/types.ts, annotations.ts and prompt.ts contain the stable finding categories, severity calibration and normalized screenshot-region marking inspired by UX Audit Skill. The complete skill workflow and mandatory full-framework sweep are not copied.
- OpenRouter: screenshot audits use the existing Model Gateway via the uxd/vision alias. That preserves model selection, provider allowlisting, usage accounting and configured budget restrictions. Image payloads are validated at the gateway boundary.
- Lighthouse: /api/ux-audit/lighthouse calls Browserless' remote /performance API, which runs Lighthouse remotely. thum.io and Browserless remain our screenshot infrastructure; no local Chrome or Playwright dependency is introduced.
- web-uplift: use evidence-first reporting, explicit coverage and re-evaluation patterns as design references only. Do not vendor its CDP runner.

## Training/reference only

- axe-core: use its rule taxonomy and deterministic result shape to train and calibrate UX Direct's audit brain. It is not a runtime dependency and is not invoked by the audit pipeline.
- Generalize reusable principles into the shared Knowledge Base only after review and approval. Keep client-specific raw evidence in Past Findings.

## Explicit exclusions

- No Playwright or Puppeteer browser automation in UX Direct.
- No Cloudflare Browser Run.
- No Lost Pixel.
- No axe-core runtime dependency.
- Do not use a generic agent framework or a separate model client in place of the existing FreeLLMAPI-backed Model Gateway.

## Runtime boundary

Crawlee targets Node.js and has storage/runtime assumptions that should not be imported into the Cloudflare Worker without a verified compatibility test. The deployed application therefore uses a small Worker-safe crawler with a Crawlee-compatible output shape. The optional Node CLI uses Crawlee's CheerioCrawler directly; it does not launch a browser. The UI and site-map data contract can be retained if a dedicated Node crawler runtime is introduced later.
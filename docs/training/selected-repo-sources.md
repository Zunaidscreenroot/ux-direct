# UX audit source notes — training/reference only

## UX Audit Skill — selected mechanics

Source: https://github.com/EliaAlberti/ux-audit-skill

License: MIT. Copyright (c) 2026 Elia Alberti. The selected reusable ideas in UX Direct are stable recurring-check categories, severity calibration against the user's goal, duplicate reduction, and normalized screenshot-region annotations. UX Direct's own implementation lives in src/ux-audit/ and uses the existing OpenRouter Model Gateway; it does not vendor the complete skill workflow or its mandatory framework sweep.

## axe-core — training only

Source: https://github.com/dequelabs/axe-core

Use axe-core as reference material for understanding how deterministic accessibility rules are named, evaluated and represented in machine-readable findings. Do not import, bundle, or invoke axe-core in UX Direct's runtime or live audit pipeline. UX Direct should store derived, reviewed learning notes in the shared Knowledge Base, distinct from client-specific Past Findings.

## web-uplift — methodology reference

Source: https://github.com/PaulKinlan/web-uplift

Use its evidence-first approach, clear separation of observations and judgments, explicit audit coverage, and re-evaluation ideas. Do not copy its Chrome DevTools Protocol runner, browser primitives, fixer, or complete principle catalogue into the Cloudflare Worker.

## Crawlee — crawl patterns / optional Node CLI

Source: https://github.com/apify/crawlee

The Cloudflare Worker uses a small bounded fetch-based site crawler with same-origin restrictions, deduplication, a finite crawl budget and retries. scripts/ia-crawl.mjs uses Crawlee's CheerioCrawler for optional Node.js use. It does not import Playwright or Puppeteer and is excluded from the Worker runtime.

## React Flow / xyflow

Source: https://github.com/xyflow/xyflow

React Flow is the interactive presentation layer for the IA graph. It does not infer page hierarchy; the crawler and relationship mapping provide the nodes and edges.

## Lighthouse

Source: https://github.com/GoogleChrome/lighthouse

Use the existing Browserless Performance API to run Lighthouse remotely. The Cloudflare Worker does not launch a local Chrome binary or run the Lighthouse CLI itself.
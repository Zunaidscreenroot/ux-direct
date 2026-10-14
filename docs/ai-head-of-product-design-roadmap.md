# AI Head of Product Design — Brain Roadmap

## Product definition

UX Direct's GOD-level Brain should behave like an AI Head of Product Design: UX-led, but capable of reasoning across product strategy, business context, visual design, design systems, responsive behaviour, accessibility, handoff quality, and technical feasibility. It should co-design with the designer, not merely generate screens.

Current priority: Indian BFCI website research, benchmarking, audits, information architecture, journeys, and polished high-fidelity editable Figma wireframes. Production website/code generation is explicitly future scope.

## Hard boundaries

- Keep work on `feature/modular-ux-hands-architecture` or another approved feature branch. Never modify `main` as part of this roadmap.
- Do not change the existing Figma plugin UI/manifest in this phase.
- Keep DMI client data and DMI-specific knowledge out of the shared Indian BFCI benchmark knowledge base. DMI data must remain in its separately managed repository/workspace.
- Shared BFCI knowledge must be sourced, timestamped, scoped, and separated from client-private material.
- Do not deploy as part of this architecture/documentation work.

## Operating workflow

1. **Research and benchmark:** maintain a reusable reference corpus for a starting set of 5 large banks, 5 NBFCs, and 5 Small Finance Banks in India. Expand only when the initial corpus and capture process are reliable.
2. **Evidence capture:** record canonical URL, capture date/time, viewport/device, screenshot, page type, observed journey/state, source, and access limitations. Do not infer unseen or gated journey steps.
3. **Benchmarking:** compare a target website against relevant, verified BFCI reference evidence and clearly distinguish observed facts from interpretation and recommendations.
4. **Targeted website audit:** audit the specific client's current website using captured screenshots and journey evidence. Every significant finding should link to evidence, impact, confidence, and a recommended fix.
5. **Journey and IA architecture:** identify page inventory, page archetypes, navigation, user goals, journeys, content requirements, states, edge cases, and missing requirements before detailed wireframing.
6. **High-fidelity wireframes:** generate a complete, consistent set of editable Figma pages using the shared component library. The result should be polished enough to target roughly 80% of the design work, leaving the UI team primarily visual refinement and production-design work; this is a target to verify, not a guaranteed score.
7. **Cockpit audit and iteration:** audit the generated pages, identify issues, propose changes, and apply authorised edits through the existing Cockpit/plugin flow. Preserve evidence and revision history.
8. **Quality and handoff:** check journey completeness, consistency, responsive behaviour, accessibility, content/disclosures, empty/loading/error/success states, component reuse, and design rationale.

## One-time reusable BFCI Wireframe Component Library

Build a persistent, reusable high-fidelity wireframe library once; do not recreate it from a prompt for every client. Research common BFCI page patterns and define reusable components, variants, states, layout rules, tokens, responsive behaviour, and usage guidance.

Candidate groups include navigation/header/footer, hero and product cards, comparison tables, eligibility and benefits sections, lead forms, OTP/input states, calculators, fee/charge disclosures, FAQs, trust/security content, CTAs, alerts, tables, pagination, empty/loading/error states, and responsive patterns. Treat this as a research checklist, not a claim that every component belongs in every client design.

The library is a reusable high-fidelity UX wireframing kit, not a substitute for each client's brand-specific production UI design system. Components must be editable and composable in Figma, with stable naming and documented variants. Use verified client requirements and approved references when choosing components.

## Brain architecture

- **Context/workspace resolver:** identify client, project, task, constraints, permissions, and relevant approved knowledge.
- **Research and evidence service:** crawl/inspect permitted public pages, capture screenshots and metadata, and track coverage and gaps.
- **Knowledge/memory service:** distinguish generic BFCI knowledge, source evidence, reusable patterns, project memory, and client-private material.
- **Planner/orchestrator:** decompose requests into research, audit, IA, journey, wireframe, critique, and handoff stages.
- **Model/tool router:** choose capabilities based on modality, reliability, latency, cost, and task requirements.
- **Design representation (Design IR):** express page hierarchy, components, constraints, content, states, interactions, and acceptance criteria before Figma execution.
- **Figma/Cockpit execution:** create or update editable frames through authorised tools; keep plugin changes out of this phase.
- **Verification and critique:** validate results against evidence and acceptance criteria, then run bounded repair iterations.
- **Learning and observability:** store concise decisions, evidence references, test outcomes, failures, costs, and approved reusable lessons. Do not promote unverified guesses into permanent knowledge.

## Future placeholder: design-to-code replication

Status: **PARKED — specification only; do not implement or integrate yet.**

Future goal: after a final UI design is approved, translate the design into a working website using HTML, CSS, and JavaScript while preserving the approved design as closely as feasible.

Future module boundary:

- Input: approved Figma file/frame references, design tokens, component metadata, assets, responsive rules, interactions, and acceptance criteria.
- Intermediate representation: a validated design-to-code specification that maps Figma structures to semantic HTML, CSS layout/tokens, JavaScript interactions, and reusable code components.
- Output: code and a runnable preview, plus a visual-diff and functional verification report.
- Quality gates: responsive viewport checks, asset/font availability, interaction behaviour, accessibility, console/build errors, and screenshot comparison against the approved design.
- Safety: never overwrite the approved Figma design; keep generated code changes isolated and reviewable.
- Integration point: connect only after the research, knowledge, wireframe library, editable Figma generation, and design QA workflow are reliable.

This placeholder does not mean code generation, deployment, or automatic design-to-code integration exists today.

## Acceptance criteria for the current design-focused phase

1. A reproducible capture process exists for the initial 15 Indian BFCI reference companies.
2. Each captured page/screen has provenance and a clear observed/inferred distinction.
3. Benchmark and audit findings are evidence-linked and can be retrieved by task context.
4. The shared wireframe component library is built once, documented, versioned, and reused across client projects.
5. A target website can be mapped into page inventory, journeys, IA, and a high-fidelity wireframe plan before generation.
6. Generated Figma pages are editable, use reusable components, and can be audited and iterated through the existing Cockpit flow.
7. DMI data is not ingested into the shared BFCI knowledge base.
8. The future design-to-code module remains a documented placeholder until explicitly prioritised.
9. No plugin UI change, main-branch change, or deployment is part of this phase.

## Implementation order

1. Inspect and test the current branch scaffold; identify what is implemented versus merely documented.
2. Stabilise BFCI source inventory, capture metadata, screenshot provenance, and knowledge schema.
3. Build the initial benchmark corpus and evidence-backed audit workflow.
4. Research, build, and validate the one-time reusable wireframe component library.
5. Connect planning and Design IR to editable Figma generation through the existing Cockpit execution path.
6. Add bounded design critique, visual/functional QA, and traceable iteration.
7. Revisit the parked design-to-code module only after the design workflow is reliable.

## Status discipline

Track every capability as one of: `implemented and tested`, `implemented but unverified`, `documented/planned`, or `blocked`. Never describe a planned capability as complete without an execution trace and test evidence.
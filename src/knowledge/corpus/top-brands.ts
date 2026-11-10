import type { KnowledgeEntry } from "../types";

/**
 * Lessons from top companies' design languages. Synthesised from the MIT-licensed
 * VoltAgent/awesome-design-md collection (DESIGN.md analyses of public brand websites) and the
 * public design systems already cited in craft.ts. Only the transferable craft lesson is kept:
 * no brand palettes, hex values, proprietary fonts or logos, because copying a brand's look is
 * imitation, not design. Use these as reasons and directions, then apply the product's own system.
 */
const SRC = "VoltAgent/awesome-design-md, MIT licence (DESIGN.md analyses of public brand sites) https://github.com/VoltAgent/awesome-design-md";
const VISUAL_ROLES: KnowledgeEntry["roles"] = ["ui-designer", "design-system", "lead", "director"];

export const TOP_BRAND_LESSONS: KnowledgeEntry[] = [
  {
    id: "brand-lesson-single-accent",
    title: "Top brands: one action colour, used sparingly",
    category: "visual",
    roles: VISUAL_ROLES,
    tags: ["accent colour", "primary colour", "cta colour", "brand colour", "colour palette", "top companies", "premium", "best designs"],
    body: "Stripe, Coinbase, Airbnb, Apple, Linear, Mercury and Slack each spend one saturated colour on actions only: the filled primary button, links, focus rings and the selected state. Most of the screen is neutral (white or dark canvas plus ink), so the one coloured element is where the eye goes. Apply: pick one action colour from the product's system; one filled primary button per view or section; secondary actions are outlined, tonal or neutral pills. Success, error, up and down colours are semantic: use them for text, icons and small tags, never as button fills. Do not add a second accent for decoration; when emphasis is needed on a coloured ground, use a contrasting neutral (white button on dark).",
    sources: [SRC, "Material 3: Color roles https://m3.material.io/styles/color/roles"],
  },
  {
    id: "brand-lesson-money-numbers",
    title: "Top fintech brands: numbers get their own typography",
    category: "visual",
    roles: VISUAL_ROLES,
    domains: ["fintech", "ecommerce", "saas", "insurance"],
    tags: ["numbers", "amount", "money", "tabular figures", "balance", "price", "rating", "fintech ui", "premium fintech"],
    body: "Stripe sets every amount with tabular figures; Coinbase renders every price and percent change in a monospaced face; Airbnb makes the rating the single loudest type on a listing because it is the top trust signal. Apply: use tabular (fixed-width) numerals for amounts, balances and tables so columns align and values do not jitter when they update; right-align amounts in lists; make the one key number on a screen (balance, EMI, total due, rating) the largest type there and keep everything else quiet; show currency symbol, sign and unit consistently. Up/down or credit/debit colour is a supplement to a sign or word, never the only cue.",
    sources: [SRC, "WCAG 2.2 SC 1.4.1 Use of Color", "Apple HIG: Typography (monospaced digits)"],
  },
  {
    id: "brand-lesson-type-restraint",
    title: "Top brands: hierarchy from one lever, quiet weights",
    category: "visual",
    roles: VISUAL_ROLES,
    tags: ["typography", "font weight", "type hierarchy", "headline", "heading size", "premium look", "calm", "trust"],
    body: "Calm, trusted brands keep display weights modest: Coinbase headlines at regular weight, Apple and Linear at semibold, Mercury and Stripe light; hierarchy comes from size and colour, not heavy bold. NerdWallet does the opposite on purpose: light body against bold headings, so weight carries hierarchy. Spotify uses a strict bold/regular binary. The lesson: choose one main hierarchy lever (size steps or weight contrast), use at most three weights, keep body regular at a comfortable size and leading, and sentence case for headings (Uber, Apple). Large display text can take slightly tighter letter-spacing; small labels never. Uppercase only for small eyebrows or labels.",
    sources: [SRC, "Material 3: Type scale https://m3.material.io/styles/typography/type-scale-tokens", "Apple HIG: Typography"],
  },
  {
    id: "brand-lesson-depth-restraint",
    title: "Top brands: separate with surfaces, not shadows",
    category: "visual",
    roles: VISUAL_ROLES,
    tags: ["shadow", "elevation", "card style", "borders", "surfaces", "depth", "flat", "clean ui"],
    body: "Apple uses one soft shadow, only under product images; Airbnb and Coinbase cap elevation at one tier; Linear builds hierarchy with a four-step ladder of surface shades on a dark canvas; NerdWallet and Mercury separate sections with tinted fills and hairlines instead of shadows. Apply: define at most one or two elevation levels and reserve them for things that float (menus, sheets, sticky bars, hovered cards). Group content with a slightly tinted surface or a 1px hairline instead of a shadow on every card. Do not combine border + shadow + tint on the same card. In dark mode, raise surfaces by lightening them, not by adding shadow.",
    sources: [SRC, "Material 3: Elevation https://m3.material.io/styles/elevation/overview"],
  },
  {
    id: "brand-lesson-shape-language",
    title: "Top brands: one consistent shape grammar",
    category: "visual",
    roles: VISUAL_ROLES,
    tags: ["border radius", "corner radius", "pill button", "rounded", "shape", "button shape", "consistency"],
    body: "Each strong brand commits to one shape grammar and never breaks it: Uber, Coinbase, Shopify and Slack make every button a pill; Notion and Linear use 8px rectangles and never pills; NerdWallet keeps controls nearly square; Airtable and Airbnb use a radius hierarchy (inputs smallest, buttons and cards larger, icon buttons round). Which grammar matters less than consistency. Apply: take the radius scale from the product's design system, assign one radius per element type (input, button, chip, card, sheet, avatar) and use it everywhere; nested corners shrink (inner radius = outer radius minus padding). Mixed radii on the same screen look unfinished.",
    sources: [SRC, "Material 3: Shape https://m3.material.io/styles/shape/overview"],
  },
  {
    id: "brand-lesson-density-rhythm",
    title: "Top brands: tight inside components, generous between them",
    category: "layout",
    roles: VISUAL_ROLES,
    tags: ["spacing", "whitespace", "density", "rhythm", "section spacing", "padding", "breathing room", "crowded"],
    body: "NerdWallet keeps table rows tight with hairlines but leaves large gaps between comparison blocks; Airbnb has an open top area and a dense card grid below; Uber stacks headline, text and button 8px apart inside a card but 32px between cards; Coinbase keeps marketing airy and puts density behind login, in the product. Apply: related items sit close (4–8px), groups are clearly further apart (16–24px), sections further still (32px+ on mobile); the gap between groups should always be visibly larger than the gap inside them (proximity). Working screens (dashboards, tables, transaction lists) can be dense; decision and onboarding screens get more air.",
    sources: [SRC, "Gestalt law of proximity https://lawsofux.com/law-of-proximity/", "Material 3: Spacing"],
  },
  {
    id: "brand-lesson-content-first",
    title: "Top brands: the real product or content is the hero",
    category: "visual",
    roles: VISUAL_ROLES,
    tags: ["hero", "illustration", "imagery", "product screenshot", "photography", "decoration", "visual interest", "empty decoration"],
    body: "Linear and Stripe lead with real product UI, Apple and Airbnb with photography of the actual thing, Uber with plain editorial illustration; none rely on decoration that fights the headline. Apply in app screens: the user's own data (balance, offer, order, document status) is the hero, not a stock illustration or promo banner; illustrations only in empty, success and onboarding states, in one consistent style; images keep their aspect ratio and are never stretched; avoid decorative gradients, blobs and glass effects unless the product's system defines them.",
    sources: [SRC, "NN/g: Photos as web content https://www.nngroup.com/articles/photos-as-web-content/"],
  },
  {
    id: "brand-lesson-style-directions",
    title: "Style directions from top companies (pick one, never clone)",
    category: "visual",
    roles: ["director", "lead", "ui-designer", "design-system"],
    tags: ["style direction", "visual direction", "look and feel", "mood", "like stripe", "like apple", "inspired by", "top companies", "best designs", "moodboard"],
    body: "When asked for a look 'like a top company', name the direction, then build it with the product's own tokens and brand. Institutional calm (Coinbase, Mercury, Stripe): neutral canvas, one action colour, modest weights, tabular numbers, lots of air; suits banking, lending, wealth. Photo-led marketplace (Airbnb): white canvas, content cards with images, soft radii, dense grid; suits travel, food, commerce. Monochrome utility (Uber): black and white, pill buttons, sentence-case bold headlines, no decoration; suits mobility and logistics. Dark pro tool (Linear): dark canvas, surface ladder, hairlines, compact; suits B2B and admin. Comparison editorial (NerdWallet): one brand colour on controls, tinted section fills, tight tables; suits product comparison. Never copy a brand's colours, fonts, logo, icons or copy.",
    sources: [SRC],
  },
  {
    id: "brand-lesson-dark-mode",
    title: "Top brands: dark interfaces done well",
    category: "visual",
    roles: VISUAL_ROLES,
    tags: ["dark mode", "dark theme", "dark ui", "night mode", "black background", "dark screen"],
    body: "Linear, Spotify, Mercury and Revolut build dark screens on a near-black canvas, not pure black, and show depth by stepping surfaces lighter (canvas → raised card → popover) with faint hairlines instead of shadows. Text is off-white for headings and a softer grey for secondary text; the single accent stays for actions and focus. Apply: define dark surface steps as tokens, check contrast for every text role (WCAG 4.5:1 body), desaturate bright brand colours slightly so they do not glow, keep images and charts legible on dark, and design both themes from the same roles rather than inverting colours.",
    sources: [SRC, "Material 3: Dark theme https://m3.material.io/styles/color/dark-theme", "WCAG 2.2 SC 1.4.3 Contrast (Minimum)"],
  },
  {
    id: "brand-lesson-band-rhythm",
    title: "Top brands: page rhythm with alternating bands",
    category: "layout",
    roles: VISUAL_ROLES,
    tags: ["landing page", "page rhythm", "sections", "bands", "alternating sections", "marketing site", "website layout"],
    body: "Apple, Revolut, Uber and Coinbase pace long pages by alternating full-width light and dark (or tinted) bands; the colour change itself divides sections, so no extra lines or boxes are needed. Airtable resets to a white canvas between each coloured signature card; Mercury and Notion centre section headlines with generous vertical space. Apply for web and long scrolling screens: one idea per band, a predictable rhythm (hero → proof → features → CTA → footer), consistent vertical spacing between bands, and a single closing call to action. In app screens, the equivalent is grouping by tinted sections instead of many bordered boxes.",
    sources: [SRC, "NN/g: Homepage design principles"],
  },
  {
    id: "brand-lesson-cta-hierarchy",
    title: "Top brands: a clear 2–3 level button hierarchy",
    category: "visual",
    roles: VISUAL_ROLES,
    tags: ["button hierarchy", "cta", "primary secondary", "button pair", "call to action", "actions"],
    body: "Uber uses three pill levels: black filled for the main action, white for secondary, soft grey for tertiary and chips. Airtable pairs a near-black filled primary with an outlined white secondary, and treats the pair as a signature. Revolut makes the brightest element on a dark band (a white pill) the primary. Apply: decide the primary, secondary and tertiary looks once, use them identically everywhere, place at most one primary per view or band, pair primary with secondary for a choice ('Apply now' + 'Check eligibility'), and keep links visually distinct from buttons.",
    sources: [SRC, "Material 3: Buttons, emphasis levels https://m3.material.io/components/all-buttons"],
  },
  {
    id: "brand-lesson-meaningful-colour",
    title: "Top brands: colour that carries meaning",
    category: "visual",
    roles: VISUAL_ROLES,
    tags: ["colour meaning", "pastel", "category colours", "tints", "friendly", "playful", "illustration colours"],
    body: "Notion's pastel card tints mirror the colour tags users already set in the product; NerdWallet's mint ladder means 'section' and its lime means 'emphasis'; Coinbase keeps green and red strictly for up and down; Revolut keeps its bright secondary colours inside illustrations, never on buttons. Apply: give every colour a job (action, status, category, surface) and keep that job across the product; category colours are tints for backgrounds and icons, not text; never reuse status colours for decoration, so success, warning and error stay trustworthy.",
    sources: [SRC, "Material 3: Color roles", "Carbon: Color usage https://carbondesignsystem.com/elements/color/usage/"],
  },
  {
    id: "brand-lesson-compact-scanning",
    title: "Top brands: compact type for scanning-heavy apps",
    category: "visual",
    roles: VISUAL_ROLES,
    tags: ["compact", "dense ui", "small text", "list heavy", "scanning", "information density", "global scripts"],
    body: "Spotify keeps a narrow type range (roughly caption to title) because people scan playlists rather than read articles; hierarchy comes from bold vs regular, and its font stack covers many scripts for global markets. Linear and admin tools follow the same idea for issue lists. Apply to list-heavy screens (transactions, orders, inbox): fewer type sizes, bold/regular contrast for name vs meta, consistent row heights, truncation with full text on open, and fonts that support Indic scripts (Devanagari, Tamil, Bengali) when content can be localised. Never go below the platform's minimum readable size.",
    sources: [SRC, "Apple HIG: Typography (minimum sizes)", "Google Noto fonts (open licence) https://fonts.google.com/noto"],
  },
];

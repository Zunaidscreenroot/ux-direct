# Cloudflare migration

This branch prepares UX Direct to move from Vercel to Cloudflare Workers. It uses the OpenNext Cloudflare adapter to keep the existing Next.js App Router and server handlers. It is intentionally separate from `main` until a Cloudflare preview has passed smoke tests.

## Cloudflare resources provisioned

- Worker target: `ux-direct.zunaid-cb7.workers.dev`
- D1 database: `ux-direct-state`
- Production D1 database ID: `85f849e4-cf2a-412a-970d-477065bb380c`
- Preview D1 database ID: `156ac74e-ffe0-4667-be59-e724d279680d`
- D1 table: `ux_direct_kv`, created by `migrations/0001_ux_direct_kv.sql`
- D1 binding: `UX_DIRECT_STATE` (production and preview database IDs are configured separately)
- Environment marker: `UX_DIRECT_ENV=production`

The D1 table stores plugin bridge sessions/commands/health reports and the persisted model-gateway settings. Keep the Worker Preview's `UX_DIRECT_STATE` binding pointed at the preview database in Cloudflare Preview settings; never configure a preview to use production D1. The usage ledger remains best-effort in-memory telemetry; it is not a transactional billing or hard budget-enforcement system.

## Build configuration

The project uses `@opennextjs/cloudflare` to adapt the existing Next.js app for Workers. The current source is not a static export: it uses API route handlers, MCP/OAuth routes and persistent storage. Do not replace this with a static Pages upload.

Install dependencies with `npm install` (not `npm ci`) until the lockfile has been regenerated for the new Cloudflare packages. Then run:

```sh
npm run cf:d1:migrate:local
npm run cf:preview
```

When ready for a remote deploy, authenticate Wrangler, then:

```sh
npm run cf:d1:migrate:remote
npm run cf:deploy
```

Use the OpenNext Worker preview before changing the public/plugin endpoint. Confirm the D1 migration, `/api/health`, `/api/tasks/plan`, `/api/plugin-bridge`, `/api/connections`, MCP metadata and OAuth routes before switching the Figma plugin to production.

## Secrets and environment variables

Copy the existing production secrets from the current hosting provider into Cloudflare Workers **Secrets**; do not put credentials in `wrangler.jsonc` or commit them to GitHub. At minimum, review every currently used provider and OAuth secret (including `OPENROUTER_API_KEY`, the enabled provider keys, and `FIGMA_CLIENT_ID`, `FIGMA_CLIENT_SECRET`, and `FIGMA_REDIRECT_URI`). Recheck any MCP/OAuth signing secret and all configured callback/issuer URLs. Keep paid model routing disabled unless the existing explicit model and budget safeguards have been revalidated.

Update any OAuth callback, MCP issuer/resource URL, CORS origin or integration registration that uses the former Vercel hostname. Do not assume the hostname change alone completes OAuth migration.

## Git integration and cutover

Cloudflare Pages/Workers Build API currently reports that this Cloudflare account has not connected its Git account, so an automatic repository build could not be created through the API. Connect GitHub to Cloudflare from the Cloudflare dashboard's Workers Builds/Git integration UI, then select `Zunaidscreenroot/ux-direct`, keep `main` as the production branch, and enable Preview Builds. Use `npm run cf:build` as the build command, `npx wrangler deploy` as the deploy command, and `npx wrangler preview` as the preview command.

The Figma plugin in this branch targets `https://ux-direct.zunaid-cb7.workers.dev`. The previous Vercel host remains allowlisted in the plugin manifest for rollback, but it is not the API target in this branch. Do not merge or import this branch's plugin manifest into a working Figma session until the Cloudflare endpoint is live and verified. Keep Vercel active until all smoke tests pass and only then remove the previous hostname.

## Smoke-test checklist

- [ ] Worker preview compiles with OpenNext and `nodejs_compat`.
- [ ] `/api/health` returns `status: "ok"` and `deployment.platform: "cloudflare"`.
- [ ] D1 writes and reads survive a separate request.
- [ ] Plugin bridge heartbeat, dashboard session read, command queue and health report persist across requests.
- [ ] `/api/tasks/plan` works with mock mode without paid inference.
- [ ] Configured OpenRouter provider readiness works without exposing secrets.
- [ ] Figma network access, CORS, MCP discovery and OAuth callback/issuer metadata work on the new hostname.
- [ ] Manual screenshot upload → AI analysis succeeds; website capture is tested separately with the intended screenshot provider.
- [ ] Only after the above: change/republish the plugin and retire the Vercel deployment.

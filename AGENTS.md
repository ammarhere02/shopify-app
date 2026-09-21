# Shopify app development

This app is scaffolded from a Shopify app template. Setup, commands and the repository map are in `README.md`.

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for all Shopify API and platform work. If missing, install it in the agent host per that page (or `npx skills add Shopify/shopify-ai-toolkit --list` for skill-compatible hosts) — do not add tooling to this repo.

## Codebase map

Project: Merchant Product Enrichment Hub (assignment PDF in repo root). What is built and verified: `docs/VERIFICATION.md`. Design reasons: `docs/DESIGN.md`.

Each main folder has its own `README.md` describing what is really there and how it works. It is the single source of context for people and agents: the folder's `CLAUDE.md` loads it (`@README.md`) and its `AGENTS.md` only points to it. Read it before changing that folder, and update it in the same change when the folder's behaviour changes:
`app/`, `app/routes/`, `app/services/`, `app/repositories/`, `app/shopify/`, `app/ai/`, `app/components/`, `db/` (Prisma schema and migrations; `package.json` → `prisma.schema`), `tests/`, `extensions/`, `scripts/`, `docker/`, `docs/`.

Small folders: `docker/mysql-init.sql` (creates the test DB and grants on first volume creation), `scripts/run-integration.mjs` (integration test runner), `scripts/api-key.ts` (`npm run api-key -- create|list|revoke <shop-domain> [label|prefix]`, run with vite-node using `vitest.config.ts` because the app's Vite config loads the React Router plugin), `docs/`.

Checks to run after a change: `npm test`, `npm run test:integration`, `npm run typecheck`, `npm run lint`, `npm run build`.

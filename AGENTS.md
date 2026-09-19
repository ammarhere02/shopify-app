# Shopify app development

This app is scaffolded from a Shopify app template. See the README for framework-specific details.

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for all Shopify API and platform work. If missing, install it in the agent host per that page (or `npx skills add Shopify/shopify-ai-toolkit --list` for skill-compatible hosts) — do not add tooling to this repo.

## Codebase map

Project: Merchant Product Enrichment Hub (assignment PDF in repo root). Phase status: `docs/PHASES.md`. Design reasons: `docs/LEARNING.md`.

Each main folder has its own `AGENTS.md` (loaded through a one-line `CLAUDE.md`) describing what is really there. Read it before changing that folder, and update it in the same change when the folder's behaviour changes:
`app/`, `app/routes/`, `app/services/`, `app/repositories/`, `app/shopify/`, `prisma/`, `tests/`, `extensions/`.

Other folders: `docker/mysql-init.sql` (creates the test DB and grants on first volume creation), `scripts/run-integration.mjs` (integration test runner), `docs/`.

Checks to run after a change: `npm test`, `npm run test:integration`, `npm run typecheck`, `npm run lint`, `npm run build`.

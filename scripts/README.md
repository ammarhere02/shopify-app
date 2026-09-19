# scripts/ — command-line helpers

Run from the repo root through `npm run`. Neither file is part of the running app.

| File | Command | What it does |
|---|---|---|
| `run-integration.mjs` | `npm run test:integration` | Reads `TEST_DATABASE_URL` (environment or `.env`), refuses any database that is not on localhost or whose name does not end in `_test`, runs `prisma migrate deploy` against it, then runs Vitest with `RUN_MYSQL_TESTS=1` so only `*.integration.test.ts` files run |
| `api-key.ts` | `npm run api-key -- create <shop-domain> [label]` | Creates a developer API key for an installed shop and prints the plaintext **once**. Only its SHA-256 hash and a 12-character prefix are stored |
| | `npm run api-key -- list <shop-domain>` | Prefix, label, last used, revoked |
| | `npm run api-key -- revoke <shop-domain> <prefix>` | Revokes matching keys. Idempotent |

`api-key.ts` runs with `vite-node --config vitest.config.ts` because the app's own `vite.config.ts` loads the React Router plugin, which a plain script cannot use. `vite-node` comes with Vitest; it is not listed separately in `package.json`.

There is no admin page for API keys yet, so this script is the only way to make one. Logic lives in `app/services/api-key.server.ts` and `app/repositories/api-key.server.ts`.

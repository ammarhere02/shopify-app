# app/components/ — React components used by pages

## What this folder is
UI that is too large to live inside a route file. Components here are client code: they may import pure modules (no `.server` in the name) and types, never repositories, `db.server` or anything that reads the environment.

| File | Used by | Behaviour |
|---|---|---|
| `AiDescriptionSection.tsx` | `routes/app.products.$id.tsx` | The AI description workflow for one product. Talks only to the resource route `/app/products/:id/generation`. **Generate**: image checkboxes (1 to `maxImages`, Shopify images of this product only), optional facts (max 2,000), model select when more than one is allowed. One idempotency key per intended generation: kept across a failed submit, replaced after a successful one, so a retried click cannot create a second billable job. **Progress**: while the job is QUEUED or RUNNING it loads `?jobId=` every 2 s and stops when the job is finished; a poll is a plain read. **Review**: status and review badges, model, tokens, latency, cost, warnings banner, failure banner with the stored error, HTML textarea next to a live preview, the other generated fields (shown only, never written), Save draft / Approve / Reject / Reset to generated text, Edit again after approval. **Write to Shopify** (step 3, shown for APPROVED/APPLYING/APPLIED): a warning when the shop has not granted `write_products` (`canWrite`), an "Apply to product…" button opening an `s-modal` that shows the last recorded text next to the new one before `intent=apply`; a STALE result shows its own banner; an APPROVED job with an `error` shows the last refusal. **Sales channels** (`canPublish`): "Publish to a channel…" loads `?publications=1` into a modal with a select (already-published channels are marked) and a warning when the product is not ACTIVE; `intent=publish`. **Versions written by this app**: newest first with `current`; Restore on older rows and "Restore what it replaced" on the newest (the text before the first apply), each through a confirmation modal showing the text, then `intent=restore` with `versionId` + `which`. **History**: last 10 generations with a View action |

## Rules
- The preview renders `sanitizeHtml(draft)` from `services/html-sanitize.ts`, the same function the server applies before storing. Never pass unsanitized text to `dangerouslySetInnerHTML`.
- No secret reaches this folder. The loader sends model names and limits only.
- Polaris web components (`s-*`) need no import; props are camelCase and typed by `@shopify/polaris-types`.
- Approving does not write to Shopify. Applying, publishing and restoring each open a confirmation modal (`s-modal` + `commandFor`/`command="--show"`) and only then submit; the server re-checks state, scope and staleness.

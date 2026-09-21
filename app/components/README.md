# app/components/ — React components used by pages

## What this folder is
UI that is too large to live inside a route file. Components here are client code: they may import pure modules (no `.server` in the name) and types, never repositories, `db.server` or anything that reads the environment.

| File | Used by | Behaviour |
|---|---|---|
| `AiDescriptionSection.tsx` | `routes/app.products.$id.tsx` | The AI description workflow for one product. Talks only to the resource route `/app/products/:id/generation`. **Generate**: image checkboxes (1 to `maxImages`, Shopify images of this product only), optional facts (max 2,000), model select when more than one is allowed. One idempotency key per intended generation: kept across a failed submit, replaced after a successful one, so a retried click cannot create a second billable job. **Progress**: while the job is QUEUED or RUNNING it loads `?jobId=` every 2 s and stops when the job is finished; a poll is a plain read. **Review**: status and review badges, model, tokens, latency, cost, warnings banner, failure banner with the stored error, HTML textarea next to a live preview, the other generated fields (shown only, never written), Save draft / Approve / Reject / Reset to generated text, Edit again after approval. **History**: last 10 generations with a View action |

## Rules
- The preview renders `sanitizeHtml(draft)` from `services/html-sanitize.ts`, the same function the server applies before storing. Never pass unsanitized text to `dangerouslySetInnerHTML`.
- No secret reaches this folder. The loader sends model names and limits only.
- Polaris web components (`s-*`) need no import; props are camelCase and typed by `@shopify/polaris-types`.
- Approving does not write to Shopify. Applying and publishing are separate actions with their own confirmation.

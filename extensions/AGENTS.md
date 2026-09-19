# extensions/ — Shopify app extensions

Empty today (only `.gitkeep`). Planned in Phase 6 (`docs/PHASES.md`): a Theme App Extension `product-badge` with a Liquid app block that shows the badge on product pages, fed by an app proxy at `/apps/product-badge/...`.

Rules for when it is built:
- Generate with `shopify app generate extension`; do not hand-create the folder layout.
- The merchant enables the block in the theme editor. The app must never edit theme files.
- Only `badgeText`, `badgeColor` may reach the storefront. Never `internalNote`.
- Escape all output in Liquid; insert dynamic text with `textContent`, not `innerHTML`. Namespace CSS classes.

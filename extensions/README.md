# extensions/ — Shopify app extensions

## What this folder is
The storefront half of the app: a Theme App Extension that lets the merchant place a **Product Badge** block on the product page from the theme editor. The block itself holds no app data. It asks the app for the current product's badge through Shopify's app proxy and stays hidden unless an active badge comes back.

Merchant steps: Online Store → Themes → Customize → open a product template → Add block → Apps → **Product Badge** → Save. For grids (Horizon): open the home page or a collection template → the section's **Product card** → Add block → Apps → **Product Card Badge**, and check that its Product setting is connected to the card's product. A badge edited in the app shows on the storefront within 60 seconds (the proxy response is cached for that long).

One extension with two app blocks: `product-badge/`, a **Theme App Extension** (`type = "theme"`), created with `shopify app generate extension`. Shopify hosts its files on its CDN; `shopify app dev` previews it and `shopify app deploy` releases it. The app never edits theme files: the merchant adds the blocks in the theme editor (product template → Add block → Apps → Product Badge; for grids: Product card → Add block → Apps → Product Card Badge).

| File | Role |
|---|---|
| `product-badge/shopify.extension.toml` | Name, type, uid. Do not change the uid |
| `product-badge/blocks/product_badge.liquid` | The app block. Liquid prints an empty, `hidden` container with `data-product-id="{{ product.id }}"` and the block settings. The `{% schema %}` JSON defines what the merchant sees: `show_badge`, `alignment`, `badge_style` (solid/outline), `text_size`, `corner_radius`; `target: section`, only on `product` templates; declares the CSS and JS assets |
| `product-badge/blocks/product_card_badge.liquid` | App block for product cards (not required by the assignment). No `enabled_on`, so it is offered on every template. Its product comes from the `product` setting (`autofill: true`), a dynamic source that resolves to each card's product inside a theme Product card block; Liquid prints only that product's id. Extra setting `reserve_space` (default on). In the theme editor, an unconnected Product setting shows a hint instead |
| `product-badge/assets/product-badge.js` | Shared by both blocks, runs once. Collects every `[data-eh-product-badge]` container not yet loaded, de-duplicates and sorts the ids, and sends one `fetch("/apps/product-badge/badges?ids=...")` per 50 products (`BATCH_MAX`, must not exceed the server's `STOREFRONT_BATCH_MAX`). Badge found: `textContent` + CSS custom properties, then unhide. Anything else: stay hidden. Re-runs on `shopify:section:load` and, debounced 150 ms, when a `MutationObserver` sees new nodes (filters, load more) |
| `product-badge/assets/product-badge.css` | Every class starts with `eh-product-badge`. No global selectors |
| `product-badge/locales/en.default.json` | Placeholder text |

## Flow
```
page with 1..n badge containers → block Liquid (product id only) → JS: one fetch /apps/product-badge/badges?ids=123,456
 → Shopify app proxy signs + forwards → app route /proxy/badges → { badges: { "123": {...} } } → DOM
(/apps/product-badge/products/123 → /proxy/products/123 → { badge } still exists and is tested; the script no longer calls it)
```
The proxy mapping is `[app_proxy]` in `shopify.app.toml` (prefix `apps`, subpath `product-badge`, url `<app>/proxy`).

## Product cards: what the theme must support
The card block works when the theme's product card is a theme block that (1) lists `{ "type": "@app" }` in its schema and (2) passes its product to child blocks as `closest.product`. Horizon does both (`blocks/_product-card.liquid`, rendered by the `product-list` "Featured collection" section and by `main-collection`), and because the card is one static block repeated per product, the merchant adds our block once per section. On themes whose cards are snippets (Dawn and similar) the block cannot be placed inside a card; an app embed would be the only option there, and it would need theme-specific DOM scraping, so it is deliberately not built.

## Rules
- The card block never reads the global `product`: on a product page that is the main product, and every recommendation card would show its badge.
- Liquid has no access to our MySQL. App data only arrives through the proxy.
- Badge text goes into the DOM with `textContent`, never `innerHTML`. The colour is re-checked against `#RRGGBB` in JS before it is used in a style.
- Values printed by Liquid come from fixed option lists and are still passed through `escape`.
- The placeholder renders only when `request.design_mode` is true (theme editor), so shoppers never see it.
- The colour is per product and lives in the app; the block controls layout and style only.
- Check changes with `npx shopify theme check --path extensions/product-badge`.

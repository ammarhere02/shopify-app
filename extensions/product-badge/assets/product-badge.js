/*
 * Product Badge app blocks (product page and product cards). Loaded deferred by Shopify (declared
 * in the block schemas). Every badge container on the page is collected and the public badges are
 * fetched through the app proxy in ONE request per 50 products, however many cards there are.
 * Missing badge, network error or bad data all end the same way: the block stays hidden.
 */
(function () {
  if (window.__ehProductBadgeLoaded) return; // two blocks declare this file; run once
  window.__ehProductBadgeLoaded = true;

  var HEX = /^#[0-9A-F]{6}$/i;
  var BATCH_MAX = 50; // must not exceed STOREFRONT_BATCH_MAX on the server

  function showPlaceholderOrHide(root) {
    // Theme editor only: the placeholder element exists, so keep the block visible for the merchant.
    root.hidden = !root.querySelector("[data-eh-badge-placeholder]");
  }

  function render(root, badge) {
    var label = root.querySelector("[data-eh-badge-label]");
    if (!label || !badge || typeof badge.text !== "string" || !badge.text || !HEX.test(badge.color)) {
      return showPlaceholderOrHide(root);
    }
    label.textContent = badge.text; // textContent, never innerHTML: badge text is data, not markup
    root.style.setProperty("--eh-badge-color", badge.color);
    if (HEX.test(badge.textColor)) root.style.setProperty("--eh-badge-text-color", badge.textColor);
    var placeholder = root.querySelector("[data-eh-badge-placeholder]");
    if (placeholder) placeholder.remove();
    root.hidden = false;
  }

  function fetchBadges(ids, rootsById) {
    function each(fn) {
      ids.forEach(function (id) { rootsById[id].forEach(function (root) { fn(root, id); }); });
    }
    fetch("/apps/product-badge/badges?ids=" + ids.join(","), { headers: { Accept: "application/json" } })
      .then(function (res) { return res.ok ? res.json() : { badges: {} }; })
      .then(function (data) {
        var badges = (data && data.badges) || {};
        each(function (root, id) {
          render(root, Object.prototype.hasOwnProperty.call(badges, id) ? badges[id] : null);
        });
      })
      .catch(function () { each(showPlaceholderOrHide); });
  }

  function init() {
    var rootsById = {};
    document.querySelectorAll("[data-eh-product-badge]:not([data-eh-loaded])").forEach(function (root) {
      root.dataset.ehLoaded = "true";
      var id = root.dataset.productId || "";
      if (!/^[1-9]\d{0,19}$/.test(id)) return showPlaceholderOrHide(root);
      (rootsById[id] = rootsById[id] || []).push(root);
    });
    // Sorted so the same page asks for the same URL and the 60s cache can answer it.
    var ids = Object.keys(rootsById).sort();
    for (var i = 0; i < ids.length; i += BATCH_MAX) fetchBadges(ids.slice(i, i + BATCH_MAX), rootsById);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
  // The theme editor re-renders sections without reloading the page.
  document.addEventListener("shopify:section:load", init);
  // Filters, "load more" and quick views add cards later. Watch for our own containers only
  // (no theme selectors), and wait for the DOM to settle so one change means one request.
  if (window.MutationObserver) {
    var timer = null;
    new MutationObserver(function () {
      clearTimeout(timer);
      timer = setTimeout(init, 150);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
})();

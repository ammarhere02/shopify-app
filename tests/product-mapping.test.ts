import { describe, expect, it } from "vitest";
import { mapProductNode } from "../app/services/product-mapping";
import { product } from "./fixtures";

describe("product mapping", () => {
  it("keeps IDs and prices exact, normalizes blanks and converts timestamps", () => {
    const mapped = mapProductNode(product());
    expect(mapped.product.shopifyProductGid).toBe("gid://shopify/Product/1");
    expect(mapped.product.vendor).toBeNull();
    expect(mapped.product.updatedAtShopify).toEqual(
      new Date("2026-07-01T00:00:00Z"),
    );
    expect(mapped.variants[0].price).toBe("19.99");
  });
  it("rejects invalid IDs and timestamps", () => {
    expect(() => mapProductNode({ ...product(), id: "123" })).toThrow(
      "Invalid product id",
    );
    expect(() => mapProductNode({ ...product(), updatedAt: "bad" })).toThrow(
      "Invalid updatedAt",
    );
  });
  it.each(["-1", "1.999", "10000000000.00", "NaN"])(
    "rejects an unrepresentable price %s",
    (price) => {
      const node = product();
      node.variants.nodes[0].price = price;
      expect(() => mapProductNode(node)).toThrow("DECIMAL");
    },
  );
  it("rejects duplicate variants from an inconsistent paginated response", () => {
    const node = product();
    node.variants.nodes.push(node.variants.nodes[0]);
    expect(() => mapProductNode(node)).toThrow("Duplicate variant");
  });
});

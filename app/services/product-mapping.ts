/**
 * Pure mapping: Shopify GraphQL shapes -> our DB record shapes.
 * No I/O here, so it is trivial to unit test.
 */

export type ShopifyVariantNode = {
  id: string;
  title: string;
  sku: string | null;
  price: string; // Money scalar arrives as a decimal string, e.g. "699.95"
};

export type ShopifyProductNode = {
  id: string;
  title: string;
  handle: string;
  status: string;
  vendor: string | null;
  productType: string | null;
  updatedAt: string; // ISO date
  variants: {
    nodes: ShopifyVariantNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

export type ProductRecord = {
  shopifyProductGid: string;
  title: string;
  handle: string;
  status: string;
  vendor: string | null;
  productType: string | null;
  updatedAtShopify: Date;
};

export type VariantRecord = {
  shopifyVariantGid: string;
  title: string;
  sku: string | null;
  price: string; // kept as string; Prisma Decimal accepts it without float rounding
};

export type MappedProduct = {
  product: ProductRecord;
  variants: VariantRecord[];
  variantsTruncated: boolean; // true if the product has more variants than we fetched
};

export class MappingError extends Error {
  constructor(
    message: string,
    public gid?: string,
  ) {
    super(message);
    this.name = "MappingError";
  }
}

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;
const PRICE = /^\d+(\.\d{1,2})?$/;

/** Empty strings from Shopify become null so "no vendor" is stored consistently. */
const blankToNull = (v: string | null | undefined) =>
  v && v.trim() ? v : null;

export function mapProductNode(node: ShopifyProductNode): MappedProduct {
  if (!PRODUCT_GID.test(node.id))
    throw new MappingError("Invalid product id", node.id);
  const updatedAt = new Date(node.updatedAt);
  if (Number.isNaN(updatedAt.getTime()))
    throw new MappingError("Invalid updatedAt", node.id);

  const variants = node.variants.nodes.map((v) => {
    if (!VARIANT_GID.test(v.id))
      throw new MappingError("Invalid variant id", node.id);
    if (
      !PRICE.test(v.price) ||
      v.price.split(".")[0].replace(/^0+/, "").length > 10
    ) {
      throw new MappingError("Price must fit DECIMAL(12,2)", node.id);
    }
    return {
      shopifyVariantGid: v.id,
      title: v.title,
      sku: blankToNull(v.sku),
      price: v.price,
    };
  });
  if (
    new Set(variants.map((v) => v.shopifyVariantGid)).size !== variants.length
  ) {
    throw new MappingError(
      "Duplicate variant ids; run the sync again",
      node.id,
    );
  }

  return {
    product: {
      shopifyProductGid: node.id,
      title: node.title,
      handle: node.handle,
      status: node.status,
      vendor: blankToNull(node.vendor),
      productType: blankToNull(node.productType),
      updatedAtShopify: updatedAt,
    },
    variants,
    variantsTruncated: node.variants.pageInfo.hasNextPage,
  };
}

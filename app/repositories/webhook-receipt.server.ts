import { Prisma } from "@prisma/client";
import db from "../db.server";

/** A RECEIVED receipt younger than this is assumed to be in flight in another request. */
export const RECEIPT_IN_FLIGHT_MS = 60_000;
const ERROR_MAX = 1000;

type Tx = Prisma.TransactionClient;

export type ReceiptInput = {
  webhookId: string;
  topic: string;
  shopDomain: string;
  shopId: number | null;
};

/** Pure decision: may a delivery whose receipt already exists be processed again? */
export function canReclaim(
  existing: { status: "RECEIVED" | "PROCESSED" | "FAILED"; receivedAt: Date },
  now: Date,
) {
  if (existing.status === "PROCESSED") return false;
  if (existing.status === "FAILED") return true;
  return now.getTime() - existing.receivedAt.getTime() >= RECEIPT_IN_FLIGHT_MS;
}

/**
 * Claim a delivery. Exactly one caller wins per webhookId:
 *  - first delivery: the INSERT succeeds (unique webhookId is the idempotency boundary);
 *  - retry of a FAILED or abandoned RECEIVED receipt: a conditional UPDATE that only one
 *    concurrent caller can match;
 *  - anything else is a duplicate.
 */
export async function claimReceipt(input: ReceiptInput): Promise<"claimed" | "duplicate"> {
  try {
    await db.webhookReceipt.create({ data: input });
    return "claimed";
  } catch (err) {
    const duplicate =
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
    if (!duplicate) throw err;
  }

  const existing = await db.webhookReceipt.findUnique({
    where: { webhookId: input.webhookId },
  });
  const now = new Date();
  if (!existing || !canReclaim(existing, now)) return "duplicate";

  const reclaimed = await db.webhookReceipt.updateMany({
    // Matching the exact state we read means a concurrent reclaim changes it first and we lose.
    where: {
      webhookId: input.webhookId,
      status: existing.status,
      receivedAt: existing.receivedAt,
    },
    data: { status: "RECEIVED", receivedAt: now, error: null, processedAt: null },
  });
  return reclaimed.count === 1 ? "claimed" : "duplicate";
}

/** Pass the transaction client so the side effect and PROCESSED commit together. */
export function markReceiptProcessed(client: Tx | typeof db, webhookId: string, note?: string) {
  return client.webhookReceipt.update({
    where: { webhookId },
    data: { status: "PROCESSED", processedAt: new Date(), error: note ?? null },
  });
}

export function markReceiptFailed(webhookId: string, message: string) {
  return db.webhookReceipt.update({
    where: { webhookId },
    data: { status: "FAILED", processedAt: new Date(), error: message.slice(0, ERROR_MAX) },
  });
}

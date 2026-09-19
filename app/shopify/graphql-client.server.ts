import { logger } from "../lib/logger.server";

/**
 * The function shape of `admin.graphql` from authenticate.admin().
 * Depending on this *type* (not the library object) lets tests pass a fake.
 */
export type AdminGraphql = (
  query: string,
  options?: {
    variables?: Record<string, unknown>;
    signal?: AbortSignal;
    tries?: number;
  },
) => Promise<Response>;

/** Why a call failed. Each kind is handled differently by callers. */
export type ShopifyErrorKind =
  | "TRANSPORT" // network / HTTP 5xx: request never got a proper answer
  | "THROTTLED" // cost bucket empty (GraphQL THROTTLED or HTTP 429)
  | "GRAPHQL" // top-level GraphQL `errors` (bad query, access denied, ...)
  | "AUTH"; // 401/403: token invalid or app uninstalled

export class ShopifyApiError extends Error {
  constructor(
    public kind: ShopifyErrorKind,
    message: string,
    public retryable: boolean,
  ) {
    super(message);
    this.name = "ShopifyApiError";
  }
}

type ThrottleStatus = {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
};

type Cost = {
  requestedQueryCost?: number;
  actualQueryCost?: number;
  throttleStatus?: ThrottleStatus;
};

export type RetryOptions = {
  maxAttempts?: number; // total tries, including the first
  baseDelayMs?: number; // 1st retry waits base, then x2 each time
  sleep?: (ms: number) => Promise<void>; // injectable so tests don't really wait
  requestTimeoutMs?: number;
  deadlineMs?: number;
  now?: () => number;
  logContext?: Record<string, unknown>;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Translate whatever the Shopify library threw into our ShopifyApiError.
 * The library throws: GraphqlQueryError (has body.errors.graphQLErrors),
 * HttpThrottlingError (429), HttpRetriableError (5xx), HttpRequestError (network),
 * HttpResponseError (other 4xx). We inspect by name/fields to stay loosely coupled.
 */
export function classifyError(error: unknown): ShopifyApiError {
  if (error instanceof ShopifyApiError) return error;
  const e = error as {
    name?: string;
    message?: string;
    response?: { code?: number; status?: number };
    body?: {
      errors?: {
        graphQLErrors?: Array<{
          message?: string;
          extensions?: { code?: string };
        }>;
      };
    };
  };
  const message = e?.message ?? "Unknown Shopify error";

  const gqlErrors = e?.body?.errors?.graphQLErrors;
  if (gqlErrors?.length) {
    const throttled = gqlErrors.some((g) => g.extensions?.code === "THROTTLED");
    return throttled
      ? new ShopifyApiError("THROTTLED", "Shopify throttled the query", true)
      : new ShopifyApiError(
          "GRAPHQL",
          gqlErrors.map((g) => g.message).join("; "),
          false,
        );
  }

  const status = e?.response?.code ?? e?.response?.status;
  if (e?.name === "HttpThrottlingError" || status === 429) {
    return new ShopifyApiError("THROTTLED", "Shopify returned 429", true);
  }
  if (status === 401 || status === 403) {
    return new ShopifyApiError(
      "AUTH",
      `Shopify rejected credentials (${status})`,
      false,
    );
  }
  if (
    [
      "HttpRetriableError",
      "HttpRequestError",
      "AbortError",
      "TimeoutError",
    ].includes(e?.name ?? "") ||
    (status && status >= 500)
  ) {
    return new ShopifyApiError("TRANSPORT", message, true);
  }
  return new ShopifyApiError("TRANSPORT", message, false);
}

/** How long to wait so the bucket holds `needed` points again. 0 if enough already. */
export function msUntilAvailable(
  status: ThrottleStatus | undefined,
  needed: number,
): number {
  if (!status || status.currentlyAvailable >= needed) return 0;
  if (status.restoreRate <= 0)
    throw new ShopifyApiError(
      "THROTTLED",
      "Shopify has no available throttle capacity",
      false,
    );
  if (needed > status.maximumAvailable)
    throw new ShopifyApiError(
      "THROTTLED",
      "Query exceeds available throttle capacity",
      false,
    );
  const missing =
    Math.min(needed, status.maximumAvailable) - status.currentlyAvailable;
  return Math.ceil((missing / status.restoreRate) * 1000);
}

/**
 * Run one GraphQL operation with:
 *  - error classification (transport vs GraphQL vs throttle vs auth)
 *  - bounded retry with exponential backoff for retryable failures only
 *  - proactive wait when the cost bucket is too low for the next call
 *  - cost logging (never logs tokens/headers)
 */
export function createShopifyClient(
  graphql: AdminGraphql,
  opts: RetryOptions = {},
) {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
  const context = opts.logContext ?? {};
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 5 ||
    requestTimeoutMs <= 0
  ) {
    throw new Error("Invalid Shopify retry options");
  }
  let lastThrottle: ThrottleStatus | undefined;
  let throttleObservedAt = now();

  const remaining = () => {
    const ms = (opts.deadlineMs ?? Infinity) - now();
    if (ms <= 0)
      throw new ShopifyApiError(
        "TRANSPORT",
        "Sync time budget exhausted; re-run safely",
        false,
      );
    return ms;
  };
  const pause = async (ms: number) => {
    if (ms >= remaining())
      throw new ShopifyApiError(
        "THROTTLED",
        "Throttle wait exceeds sync time budget; re-run safely",
        false,
      );
    await sleep(ms);
  };

  async function query<T>(
    operationName: string,
    document: string,
    variables?: Record<string, unknown>,
    expectedCost = 0,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      // Proactive: if the last response said the bucket is low, wait for refill first.
      remaining();
      const available = lastThrottle && {
        ...lastThrottle,
        currentlyAvailable: Math.min(
          lastThrottle.maximumAvailable,
          lastThrottle.currentlyAvailable +
            (Math.max(0, now() - throttleObservedAt) / 1000) *
              lastThrottle.restoreRate,
        ),
      };
      const wait = msUntilAvailable(available, expectedCost);
      if (wait > 0) {
        logger.info("shopify.throttle_wait", {
          ...context,
          operationName,
          waitMs: wait,
        });
        await pause(wait);
      }

      const started = Date.now();
      try {
        const res = await graphql(document, {
          variables,
          tries: 1, // Our wrapper owns retries, rather than multiplying SDK retries.
          signal: AbortSignal.timeout(
            Math.max(1, Math.floor(Math.min(requestTimeoutMs, remaining()))),
          ),
        });
        if (!res.ok) {
          throw classifyError({
            response: { status: res.status },
            message: `Shopify returned HTTP ${res.status}`,
          });
        }
        const body = (await res.json()) as {
          data?: T;
          errors?: Array<{ message: string; extensions?: { code?: string } }>;
          extensions?: { cost?: Cost };
        };
        const cost = body.extensions?.cost;
        lastThrottle = cost?.throttleStatus;
        throttleObservedAt = now();
        if (body.errors?.length) {
          throw classifyError({
            body: { errors: { graphQLErrors: body.errors } },
          });
        }
        if (body.data == null)
          throw new ShopifyApiError(
            "GRAPHQL",
            "Shopify returned no data",
            false,
          );
        logger.info("shopify.graphql", {
          ...context,
          operationName,
          attempt,
          durationMs: Date.now() - started,
          requestedCost: cost?.requestedQueryCost,
          actualCost: cost?.actualQueryCost,
          available: cost?.throttleStatus?.currentlyAvailable,
        });
        return body.data;
      } catch (raw) {
        // The framework signals "session invalid -> re-authenticate" by THROWING a Response
        // (e.g. 401/302). It must reach React Router untouched; retrying would not help.
        if (raw instanceof Response) {
          logger.warn("shopify.graphql_reauth", {
            ...context,
            operationName,
            status: raw.status,
          });
          throw raw;
        }
        const err = classifyError(raw);
        logger.warn("shopify.graphql_failed", {
          ...context,
          operationName,
          attempt,
          kind: err.kind,
          retryable: err.retryable,
          message: err.message,
        });
        if (!err.retryable || attempt >= maxAttempts) throw err;
        await pause(baseDelayMs * 2 ** (attempt - 1)); // 1s, 2s, 4s ...
      }
    }
  }

  return { query };
}

export type ShopifyClient = ReturnType<typeof createShopifyClient>;

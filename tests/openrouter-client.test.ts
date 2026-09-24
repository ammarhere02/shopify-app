import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAiConfig } from "../app/ai/config.server";
import { AiProviderError, classifyStatus, createOpenRouterClient, extractCitations } from "../app/ai/openrouter-client.server";
import type { GenerationRequest } from "../app/ai/openrouter-client.server";

const KEY = "sk-or-v1-secret-value";
const config = loadAiConfig({
  OPENROUTER_API_KEY: KEY,
  OPENROUTER_MODELS: "vendor/vision:free",
  OPENROUTER_DATA_COLLECTION: "allow",
  OPENROUTER_TIMEOUT_MS: "1000",
});
const request: GenerationRequest = {
  model: "vendor/vision:free",
  messages: [
    { role: "system", content: "rules" },
    { role: "user", content: [{ type: "text", text: "PRIVATE PROMPT" }, { type: "image_url", image_url: { url: "https://cdn.shopify.com/a.jpg" } }] },
  ],
  jsonSchema: { name: "product_description", schema: { type: "object" } },
  maxOutputTokens: 1500,
};
const ok = (overrides: object = {}) =>
  new Response(
    JSON.stringify({
      id: "gen-abc",
      model: "vendor/vision:free",
      choices: [{ finish_reason: "stop", message: { content: '{"a":1}' } }],
      usage: { prompt_tokens: 812, completion_tokens: 240, cost: 0 },
      ...overrides,
    }),
    { status: 200 },
  );
const status = (code: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code, message: `upstream said ${code}` } }), { status: code, headers });

function client(responses: Array<Response | Error>) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
  return { fetchMock, sleep, ai: createOpenRouterClient(config, { fetch: fetchMock as unknown as typeof fetch, sleep }) };
}
const kindOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return (err as AiProviderError).kind;
  }
  return "NO_ERROR";
};

afterEach(() => vi.restoreAllMocks());

describe("request", () => {
  it("sends a strict json_schema request with text before images and the configured data policy", async () => {
    const { ai, fetchMock } = client([ok()]);
    await ai.generate(request);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: "vendor/vision:free",
      max_tokens: 1500,
      response_format: { type: "json_schema", json_schema: { name: "product_description", strict: true } },
      provider: { require_parameters: true, data_collection: "allow" },
      usage: { include: true },
    });
    expect(body.messages[1].content.map((p: { type: string }) => p.type)).toEqual(["text", "image_url"]);
  });

  it("returns content, generation id, usage and latency", async () => {
    const { ai } = client([ok()]);
    expect(await ai.generate(request)).toMatchObject({
      content: '{"a":1}',
      generationId: "gen-abc",
      promptTokens: 812,
      completionTokens: 240,
      cost: 0,
    });
  });

  it("sends no tools without web search, and reports no citations or searches", async () => {
    const { ai, fetchMock } = client([ok()]);
    const result = await ai.generate(request);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("max_tool_calls");
    expect(result).toMatchObject({ citations: [], searchCount: null });
  });

  it("adds the bounded web search server tool and returns the cited pages and search count", async () => {
    const annotations = [
      { type: "url_citation", url_citation: { url: "https://www.acme.example/specs", title: "Specs" } },
      { type: "url_citation", url_citation: { url: "https://www.acme.example/specs" } }, // duplicate
      { type: "url_citation", url_citation: { url: "ftp://acme.example/x" } }, // not http(s)
      { type: "url_citation", url_citation: { url: "not a url" } },
      { type: "other", url_citation: { url: "https://ignored.example/" } },
    ];
    const { ai, fetchMock } = client([
      ok({
        choices: [{ finish_reason: "stop", message: { content: '{"a":1}', annotations } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.01, server_tool_use: { web_search_requests: 2 } },
      }),
    ]);
    const result = await ai.generate({ ...request, webSearch: { maxUses: 2, maxResults: 5 } });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.tools).toEqual([
      { type: "openrouter:web_search", parameters: { max_uses: 2, max_results: 5, max_total_results: 10 } },
    ]);
    expect(body.max_tool_calls).toBe(2);
    expect(body.response_format.type).toBe("json_schema"); // the research answer is structured too
    expect(result.citations).toEqual([{ url: "https://www.acme.example/specs", title: "Specs" }]);
    expect(result.searchCount).toBe(2);
    expect(extractCitations(undefined)).toEqual([]);
  });

  it("succeeds when usage is missing", async () => {
    const { ai } = client([ok({ usage: undefined, id: undefined })]);
    expect(await ai.generate(request)).toMatchObject({ promptTokens: null, completionTokens: null, cost: null, generationId: null });
  });
});

describe("failures that are retried", () => {
  it("retries 429 and 5xx, then succeeds", async () => {
    const { ai, fetchMock, sleep } = client([status(429), status(503), ok()]);
    expect((await ai.generate(request)).generationId).toBe("gen-abc");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it("honours Retry-After, but gives up when the wait is too long", async () => {
    const short = client([status(429, { "retry-after": "3" }), ok()]);
    await short.ai.generate(request);
    expect(short.sleep).toHaveBeenCalledWith(3000);

    const long = client([status(429, { "retry-after": "3600" }), ok()]);
    expect(await kindOf(long.ai.generate(request))).toBe("RATE_LIMITED");
    expect(long.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops after the configured number of retries", async () => {
    const { ai, fetchMock } = client([status(500), status(502), status(503), ok()]);
    expect(await kindOf(ai.generate(request))).toBe("TRANSPORT");
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 try + OPENROUTER_MAX_RETRIES (2)
  });

  it("treats a timeout and a network error as retryable", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const { ai, fetchMock } = client([timeout, new TypeError("fetch failed"), ok()]);
    await ai.generate(request);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("classifies a provider error reported inside a 200 body", async () => {
    const { ai, fetchMock } = client([ok({ error: { code: 429, message: "upstream busy" }, choices: undefined }), ok()]);
    await ai.generate(request);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("failures that are not retried", () => {
  it.each([
    [401, "AUTH"],
    [402, "AUTH"],
    [400, "UNSUPPORTED"],
    [404, "UNSUPPORTED"],
  ])("HTTP %i → %s, one call", async (code, kind) => {
    const { ai, fetchMock } = client([status(code), ok()]);
    expect(await kindOf(ai.generate(request))).toBe(kind);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a refusal, an empty answer or a truncated answer", async () => {
    const refusal = client([ok({ choices: [{ finish_reason: "stop", message: { content: null, refusal: "I can't help" } }] }), ok()]);
    expect(await kindOf(refusal.ai.generate(request))).toBe("REFUSED");
    const filtered = client([ok({ choices: [{ finish_reason: "content_filter", message: { content: "" } }] })]);
    expect(await kindOf(filtered.ai.generate(request))).toBe("REFUSED");
    const empty = client([ok({ choices: [{ finish_reason: "stop", message: { content: "  " } }] }), ok()]);
    expect(await kindOf(empty.ai.generate(request))).toBe("INVALID_OUTPUT");
    const cut = client([ok({ choices: [{ finish_reason: "length", message: { content: '{"descr' } }] }), ok()]);
    expect(await kindOf(cut.ai.generate(request))).toBe("INVALID_OUTPUT");
    for (const c of [refusal, empty, cut]) expect(c.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("says why an answer is unusable: the finish reason, the output size and the limit", async () => {
    const searching = client([ok({ choices: [{ finish_reason: "tool_calls", message: { content: null } }], usage: { completion_tokens: 40 } })]);
    await expect(searching.ai.generate(request)).rejects.toThrow(
      /empty answer \(finish reason: tool_calls, 40 output tokens\); the model stopped while it still wanted to search/,
    );
    const cut = client([ok({ choices: [{ finish_reason: "length", message: { content: "" } }], usage: { completion_tokens: 1000 } })]);
    await expect(cut.ai.generate(request)).rejects.toThrow(
      new RegExp(`cut off at the output token limit of ${request.maxOutputTokens} \\(finish reason: length, 1000 output tokens\\)`),
    );
  });

  it("maps statuses", () => {
    expect(classifyStatus(429, "")).toMatchObject({ kind: "RATE_LIMITED", retryable: true });
    expect(classifyStatus(408, "")).toMatchObject({ kind: "TIMEOUT", retryable: true });
    expect(classifyStatus(503, "")).toMatchObject({ kind: "TRANSPORT", retryable: true });
    expect(classifyStatus(403, "")).toMatchObject({ kind: "AUTH", retryable: false });
    expect(classifyStatus(422, "x".repeat(1000)).message.length).toBeLessThan(400);
  });
});

describe("logging", () => {
  it("never logs the key, the prompt, the image URL or the answer", async () => {
    const lines: string[] = [];
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(String(args[0])));
    }
    const { ai } = client([status(500), ok(), status(401)]);
    await ai.generate(request);
    await ai.generate(request).catch(() => undefined);
    const all = lines.join("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(all).toContain("gen-abc");
    expect(all).toContain('"usagePrompt":812');
    for (const secret of [KEY, "Bearer", "PRIVATE PROMPT", "cdn.shopify.com", '{\\"a\\":1}']) {
      expect(all).not.toContain(secret);
    }
  });
});

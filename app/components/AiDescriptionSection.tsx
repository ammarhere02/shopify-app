import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { GenerationActionResult } from "../routes/app.products.$id_.generation";
import { isGenerationFinished } from "../services/generation-view";
import type { GenerationView } from "../services/generation-view";
import { sanitizeHtml } from "../services/html-sanitize";

const POLL_MS = 2000;
const CONTEXT_MAX = 2000;
const HTML_MAX = 10_000;

export type AiImage = { id: string; url: string; alt: string | null };
export type AiHistoryItem = Pick<GenerationView, "id" | "status" | "reviewStatus" | "model" | "createdAt">;

type Props = {
  productId: number;
  configured: boolean;
  models: string[];
  maxImages: number;
  images: AiImage[];
  imagesError: string | null;
  latest: GenerationView | null;
  history: AiHistoryItem[];
};

const STATUS_TONE = { QUEUED: "info", RUNNING: "info", SUCCEEDED: "success", FAILED: "critical" } as const;
const REVIEW_TONE = { DRAFT: "info", APPROVED: "success", REJECTED: "neutral", APPLIED: "success" } as const;

/** One key per intended generation: a retried submit reuses it, the next click gets a new one. */
const newKey = () => crypto.randomUUID();

export function AiDescriptionSection(props: Props) {
  const { productId, configured, models, maxImages, images } = props;
  const endpoint = `/app/products/${productId}/generation`;
  const actions = useFetcher<GenerationActionResult>();
  const poll = useFetcher<{ job: GenerationView }>();

  const [job, setJob] = useState<GenerationView | null>(props.latest);
  const [history, setHistory] = useState<AiHistoryItem[]>(props.history);
  const [selected, setSelected] = useState<string[]>(images[0] ? [images[0].id] : []);
  const [context, setContext] = useState("");
  const [model, setModel] = useState(models[0] ?? "");
  const [draft, setDraft] = useState(props.latest?.draftHtml ?? "");
  const idempotencyKey = useRef(newKey());

  const showJob = (next: GenerationView) => {
    setJob(next);
    setHistory((items) => {
      const item = { id: next.id, status: next.status, reviewStatus: next.reviewStatus, model: next.model, createdAt: next.createdAt };
      return items.some((i) => i.id === next.id)
        ? items.map((i) => (i.id === next.id ? item : i))
        : [item, ...items];
    });
  };

  // Result of generate / save / approve / reject.
  useEffect(() => {
    const data = actions.data;
    if (!data?.ok) return;
    idempotencyKey.current = newKey();
    showJob(data.job);
    setDraft(data.job.draftHtml ?? "");
  }, [actions.data]);

  // Poll result: a plain read, so a lost or repeated poll changes nothing.
  useEffect(() => {
    const next = poll.data?.job;
    if (!next) return;
    showJob(next);
    if (isGenerationFinished(next.status)) setDraft(next.draftHtml ?? "");
  }, [poll.data]);

  const running = job !== null && !isGenerationFinished(job.status);
  const runningJobId = running ? job.id : null;
  // The fetcher object changes on every render; a ref lets the interval use the current one
  // without restarting the timer each time.
  const pollRef = useRef(poll);
  pollRef.current = poll;
  useEffect(() => {
    if (runningJobId === null) return;
    const timer = setInterval(() => {
      if (pollRef.current.state === "idle") pollRef.current.load(`${endpoint}?jobId=${runningJobId}`);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [runningJobId, endpoint]);

  const preview = useMemo(() => sanitizeHtml(draft), [draft]);
  const busy = actions.state !== "idle";
  const result = actions.data;
  const errors: Record<string, string> = result && !result.ok ? result.errors : {};

  const send = (intent: string, fields: Record<string, string> = {}, mediaIds: string[] = []) => {
    const form = new FormData();
    form.set("intent", intent);
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    for (const id of mediaIds) form.append("mediaIds", id);
    actions.submit(form, { method: "post", action: endpoint });
  };
  const generate = (intent: "generate" | "regenerate") =>
    send(
      intent,
      {
        idempotencyKey: idempotencyKey.current,
        merchantContext: context,
        model,
        ...(intent === "regenerate" && job ? { jobId: String(job.id) } : {}),
      },
      selected,
    );
  const review = (intent: "saveDraft" | "approve" | "reject" | "reopen") =>
    job && send(intent, { jobId: String(job.id), ...(intent === "saveDraft" || intent === "approve" ? { descriptionHtml: draft } : {}) });

  const toggle = (id: string, checked: boolean) =>
    setSelected((ids) => (checked ? [...ids.filter((i) => i !== id), id].slice(0, maxImages) : ids.filter((i) => i !== id)));

  const canGenerate = configured && selected.length >= 1 && selected.length <= maxImages && !running && !busy;
  const isDraft = job?.status === "SUCCEEDED" && job.reviewStatus === "DRAFT";

  return (
    <s-section heading="AI description">
      <s-stack gap="base">
        {!configured && (
          <s-banner tone="warning">
            AI generation is not configured on this server. Set OPENROUTER_API_KEY and OPENROUTER_MODELS.
          </s-banner>
        )}
        {props.imagesError && <s-banner tone="warning">{props.imagesError}</s-banner>}
        {result && (
          <s-banner tone={result.ok ? "success" : "critical"}>{result.message}</s-banner>
        )}

        <s-heading>1. Choose images and add facts</s-heading>
        {images.length === 0 ? (
          <s-paragraph>This product has no ready images in Shopify. Add an image to the product first.</s-paragraph>
        ) : (
          <s-stack direction="inline" gap="base">
            {images.map((image, index) => (
              <s-box key={image.id} padding="small" border="base" borderRadius="base">
                <s-stack gap="small" alignItems="center">
                  <s-thumbnail src={image.url} alt={image.alt ?? `Product image ${index + 1}`} size="large" />
                  <s-checkbox
                    label={`Image ${index + 1}`}
                    checked={selected.includes(image.id)}
                    disabled={!selected.includes(image.id) && selected.length >= maxImages}
                    onChange={(e) => toggle(image.id, e.currentTarget.checked)}
                  />
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
        {errors.mediaIds && <s-text tone="critical">{errors.mediaIds}</s-text>}
        <s-paragraph color="subdued">
          Select 1 to {maxImages} images. Only Shopify images of this product can be used.
        </s-paragraph>

        <s-text-area
          label="Facts for the writer (optional)"
          details="Audience, tone, material, benefits, keywords. Only facts stated here or in Shopify count as verified."
          value={context}
          rows={4}
          maxLength={CONTEXT_MAX}
          error={errors.merchantContext}
          onInput={(e) => setContext(e.currentTarget.value)}
        />
        {models.length > 1 && (
          <s-select label="Model" value={model} error={errors.model} onChange={(e) => setModel(e.currentTarget.value)}>
            {models.map((m) => (
              <s-option key={m} value={m}>
                {m}
              </s-option>
            ))}
          </s-select>
        )}
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-button variant="primary" disabled={!canGenerate} loading={busy && !job} onClick={() => generate("generate")}>
            Generate description
          </s-button>
          {job && isGenerationFinished(job.status) && (
            <s-button disabled={!canGenerate} onClick={() => generate("regenerate")}>
              Regenerate
            </s-button>
          )}
          <s-text color="subdued">Generating never changes your Shopify product.</s-text>
        </s-stack>

        {job && (
          <>
            <s-divider />
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-heading>2. Generation #{job.id}</s-heading>
              <s-badge tone={STATUS_TONE[job.status as keyof typeof STATUS_TONE] ?? "neutral"}>{job.status}</s-badge>
              {job.reviewStatus && (
                <s-badge tone={REVIEW_TONE[job.reviewStatus as keyof typeof REVIEW_TONE] ?? "neutral"}>
                  {job.reviewStatus}
                </s-badge>
              )}
              {running && <s-spinner size="base" accessibilityLabel="Generating" />}
            </s-stack>
            <s-text color="subdued">
              {job.model} · prompt {job.promptVersion}
              {job.usage &&
                ` · ${job.usage.promptTokens ?? "?"} in / ${job.usage.completionTokens ?? "?"} out tokens · ` +
                  `${(job.usage.latencyMs / 1000).toFixed(1)} s · ` +
                  (job.usage.estimatedCostUsd === null ? "cost not reported" : `$${job.usage.estimatedCostUsd.toFixed(6)}`)}
            </s-text>

            {running && <s-paragraph>Writing the description. This usually takes 5 to 30 seconds.</s-paragraph>}
            {job.status === "FAILED" && (
              <s-banner tone="critical" heading="Generation failed">
                {job.error ?? "Unknown error"}. Nothing was changed. You can regenerate.
              </s-banner>
            )}
            {job.warnings.length > 0 && (
              <s-banner tone="warning" heading="Check these before approving">
                <s-unordered-list>
                  {job.warnings.map((warning) => (
                    <s-list-item key={warning}>{warning}</s-list-item>
                  ))}
                </s-unordered-list>
              </s-banner>
            )}

            {job.status === "SUCCEEDED" && (
              <>
                <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                  <s-text-area
                    label="Description HTML"
                    details="Allowed: p, h2-h4, ul, ol, li, strong, em, br. Anything else is removed when saved."
                    value={draft}
                    rows={14}
                    maxLength={HTML_MAX}
                    readOnly={!isDraft}
                    error={errors.descriptionHtml}
                    onInput={(e) => setDraft(e.currentTarget.value)}
                  />
                  <s-stack gap="small">
                    <s-text type="strong">Preview (as it will be saved)</s-text>
                    <s-box padding="base" border="base" borderRadius="base" background="subdued">
                      {/* Safe: `preview` went through the same allowlist sanitizer the server uses. */}
                      <div dangerouslySetInnerHTML={{ __html: preview }} />
                    </s-box>
                  </s-stack>
                </s-grid>

                {job.generated && (
                  <s-box padding="base" border="base" borderRadius="base">
                    <s-stack gap="small">
                      <s-text type="strong">Also suggested (not written anywhere)</s-text>
                      <s-text>Short: {job.generated.shortDescription}</s-text>
                      <s-text>SEO title: {job.generated.seoTitle}</s-text>
                      <s-text>SEO description: {job.generated.seoDescription}</s-text>
                      {job.generated.highlights.length > 0 && (
                        <s-text>Highlights: {job.generated.highlights.join(" · ")}</s-text>
                      )}
                    </s-stack>
                  </s-box>
                )}

                <s-stack direction="inline" gap="base" alignItems="center">
                  {isDraft && (
                    <>
                      <s-button disabled={busy} onClick={() => review("saveDraft")}>
                        Save draft
                      </s-button>
                      <s-button variant="primary" disabled={busy} onClick={() => review("approve")}>
                        Approve
                      </s-button>
                      <s-button tone="critical" disabled={busy} onClick={() => review("reject")}>
                        Reject
                      </s-button>
                      {job.generated && draft !== job.generated.descriptionHtml && (
                        <s-button variant="tertiary" onClick={() => setDraft(job.generated!.descriptionHtml)}>
                          Reset to generated text
                        </s-button>
                      )}
                    </>
                  )}
                  {job.reviewStatus === "APPROVED" && (
                    <>
                      <s-text>Approved. It is not in Shopify yet: applying is a separate step.</s-text>
                      <s-button disabled={busy} onClick={() => review("reopen")}>
                        Edit again
                      </s-button>
                    </>
                  )}
                  {job.reviewStatus === "REJECTED" && <s-text>Rejected. Regenerate to try again.</s-text>}
                </s-stack>
              </>
            )}
          </>
        )}

        {history.length > 0 && (
          <>
            <s-divider />
            <s-heading>History</s-heading>
            <s-unordered-list>
              {history.map((item) => (
                <s-list-item key={item.id}>
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-text>
                      #{item.id} · {new Date(item.createdAt).toLocaleString()} · {item.model}
                    </s-text>
                    <s-badge tone={STATUS_TONE[item.status as keyof typeof STATUS_TONE] ?? "neutral"}>
                      {item.reviewStatus ?? item.status}
                    </s-badge>
                    {item.id !== job?.id && (
                      <s-button variant="tertiary" onClick={() => poll.load(`${endpoint}?jobId=${item.id}`)}>
                        View
                      </s-button>
                    )}
                  </s-stack>
                </s-list-item>
              ))}
            </s-unordered-list>
          </>
        )}
      </s-stack>
    </s-section>
  );
}

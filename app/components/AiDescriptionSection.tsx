import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { GenerationActionResult, GenerationLoaderData } from "../routes/app.products.$id_.generation";
import type { VersionView } from "../services/description-apply.server";
import { isGenerationFinished } from "../services/generation-view";
import type { GenerationView } from "../services/generation-view";
import { sanitizeHtml } from "../services/html-sanitize";
import type { PublicationChoice } from "../services/publication.server";

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
  versions: VersionView[];
  canWrite: boolean;
  canPublish: boolean;
  productStatus: string;
};

const STATUS_TONE = { QUEUED: "info", RUNNING: "info", SUCCEEDED: "success", FAILED: "critical" } as const;
const REVIEW_TONE = { DRAFT: "info", APPROVED: "success", REJECTED: "neutral", APPLYING: "info", APPLIED: "success" } as const;
const APPLY_MODAL = "ai-apply-confirm";
const PUBLISH_MODAL = "ai-publish-confirm";
const RESTORE_MODAL = "ai-restore-confirm";

/** One key per intended generation: a retried submit reuses it, the next click gets a new one. */
const newKey = () => crypto.randomUUID();

export function AiDescriptionSection(props: Props) {
  const { productId, configured, models, maxImages, images } = props;
  const endpoint = `/app/products/${productId}/generation`;
  const actions = useFetcher<GenerationActionResult>();
  const poll = useFetcher<GenerationLoaderData>();
  const channels = useFetcher<GenerationLoaderData>();

  const [job, setJob] = useState<GenerationView | null>(props.latest);
  const [history, setHistory] = useState<AiHistoryItem[]>(props.history);
  const [versions, setVersions] = useState<VersionView[]>(props.versions);
  const [publicationId, setPublicationId] = useState("");
  // A version row holds two texts: what it wrote and what it replaced. Either can be restored.
  const [restoreTarget, setRestoreTarget] = useState<{ versionId: number; which: "written" | "previous"; html: string } | null>(null);
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

  // Result of generate / save / approve / reject / apply / restore / publish.
  useEffect(() => {
    const data = actions.data;
    if (!data?.ok) return;
    idempotencyKey.current = newKey();
    if (data.job) {
      showJob(data.job);
      setDraft(data.job.draftHtml ?? "");
    }
    if (data.versions) setVersions(data.versions);
  }, [actions.data]);

  // Poll result: a plain read, so a lost or repeated poll changes nothing.
  useEffect(() => {
    const next = poll.data && "job" in poll.data ? poll.data.job : null;
    if (!next) return;
    showJob(next);
    if (isGenerationFinished(next.status)) setDraft(next.draftHtml ?? "");
  }, [poll.data]);

  const channelData = channels.data;
  const publications = useMemo<PublicationChoice[]>(
    () => (channelData && "publications" in channelData ? channelData.publications : []),
    [channelData],
  );
  const publicationsError = channels.data && "publicationsError" in channels.data ? channels.data.publicationsError : null;
  const liveStatus = channels.data && "productStatus" in channels.data ? channels.data.productStatus : props.productStatus;
  useEffect(() => {
    if (!publicationId && publications[0]) setPublicationId(publications.find((p) => !p.published)?.id ?? publications[0].id);
  }, [publications, publicationId]);

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
  const review = (intent: "saveDraft" | "approve" | "reject" | "reopen" | "apply") =>
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

                {(job.reviewStatus === "APPROVED" || job.reviewStatus === "APPLYING" || job.reviewStatus === "APPLIED") && (
                  <>
                    <s-divider />
                    <s-heading>3. Write to Shopify</s-heading>
                    {!props.canWrite && (
                      <s-banner tone="warning">
                        This store has not granted the app permission to write products yet. Reload the app from
                        Shopify admin and accept the new permission, then come back here.
                      </s-banner>
                    )}
                    {result && !result.ok && result.code === "STALE" && (
                      <s-banner tone="critical" heading="The product changed in Shopify">
                        Someone edited this product&apos;s description after this text was generated. Reload the page to
                        see the current text, or regenerate from it.
                      </s-banner>
                    )}
                    {job.error && job.reviewStatus === "APPROVED" && (
                      <s-banner tone="warning">{job.error}</s-banner>
                    )}
                    {job.reviewStatus === "APPLIED" && (
                      <s-banner tone="success">This description is live in Shopify (see Versions below to restore an earlier one).</s-banner>
                    )}
                    {job.reviewStatus === "APPLYING" && <s-paragraph>Writing to Shopify…</s-paragraph>}
                    {job.reviewStatus === "APPROVED" && (
                      <s-stack direction="inline" gap="base" alignItems="center">
                        <s-button variant="primary" disabled={busy || !props.canWrite} commandFor={APPLY_MODAL} command="--show">
                          Apply to product…
                        </s-button>
                        <s-text color="subdued">Replaces the product description in Shopify. You can restore the previous one later.</s-text>
                      </s-stack>
                    )}

                    <s-modal id={APPLY_MODAL} heading="Replace the product description?" size="large">
                      <s-stack gap="base">
                        <s-paragraph>
                          The current description in Shopify will be replaced by the approved text. The previous
                          text is kept in Versions and can be restored.
                        </s-paragraph>
                        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                          <s-stack gap="small">
                            <s-text type="strong">Previous (last known)</s-text>
                            <s-box padding="base" border="base" borderRadius="base" background="subdued">
                              <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(versions[0]?.descriptionHtml ?? "") || "<p><em>Not recorded by this app yet.</em></p>" }} />
                            </s-box>
                          </s-stack>
                          <s-stack gap="small">
                            <s-text type="strong">New</s-text>
                            <s-box padding="base" border="base" borderRadius="base">
                              <div dangerouslySetInnerHTML={{ __html: preview }} />
                            </s-box>
                          </s-stack>
                        </s-grid>
                      </s-stack>
                      <s-button slot="secondary-actions" commandFor={APPLY_MODAL} command="--hide">
                        Cancel
                      </s-button>
                      <s-button
                        slot="primary-action"
                        variant="primary"
                        loading={busy}
                        commandFor={APPLY_MODAL}
                        command="--hide"
                        onClick={() => review("apply")}
                      >
                        Apply to Shopify
                      </s-button>
                    </s-modal>
                  </>
                )}
              </>
            )}
          </>
        )}

        {(versions.length > 0 || props.canPublish) && <s-divider />}

        {props.canPublish && (
          <>
            <s-heading>Sales channels</s-heading>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button
                disabled={busy}
                commandFor={PUBLISH_MODAL}
                command="--show"
                onClick={() => channels.load(`${endpoint}?publications=1`)}
              >
                Publish to a channel…
              </s-button>
              <s-text color="subdued">
                Makes the product visible on one sales channel. The product must be Active in Shopify.
              </s-text>
            </s-stack>
            <s-modal id={PUBLISH_MODAL} heading="Publish this product?">
              <s-stack gap="base">
                {channels.state !== "idle" && <s-spinner size="base" accessibilityLabel="Loading sales channels" />}
                {publicationsError && <s-banner tone="critical">{publicationsError}</s-banner>}
                {liveStatus !== "ACTIVE" && (
                  <s-banner tone="warning">
                    The product is {liveStatus}. Shopify only shows Active products, so set it to Active in Shopify first.
                  </s-banner>
                )}
                {publications.length > 0 && (
                  <s-select
                    label="Sales channel"
                    value={publicationId}
                    error={errors.publicationId}
                    onChange={(e) => setPublicationId(e.currentTarget.value)}
                  >
                    {publications.map((p) => (
                      <s-option key={p.id} value={p.id}>
                        {p.name}
                        {p.published ? " (already published)" : ""}
                      </s-option>
                    ))}
                  </s-select>
                )}
              </s-stack>
              <s-button slot="secondary-actions" commandFor={PUBLISH_MODAL} command="--hide">
                Cancel
              </s-button>
              <s-button
                slot="primary-action"
                variant="primary"
                disabled={!publicationId || liveStatus !== "ACTIVE" || busy}
                commandFor={PUBLISH_MODAL}
                command="--hide"
                onClick={() => send("publish", { publicationId })}
              >
                Publish
              </s-button>
            </s-modal>
          </>
        )}

        {versions.length > 0 && (
          <>
            <s-heading>Versions written by this app</s-heading>
            <s-unordered-list>
              {versions.map((v, index) => (
                <s-list-item key={v.id}>
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-text>
                      v{v.id} · {new Date(v.appliedAt).toLocaleString()} · {v.source === "RESTORE" ? `restored from v${v.restoredFromVersionId}` : `generation #${v.generationId}`} · by {v.appliedBy}
                    </s-text>
                    {index === 0 && <s-badge tone="success">current</s-badge>}
                    {index > 0 && props.canWrite && (
                      <s-button
                        variant="tertiary"
                        disabled={busy}
                        commandFor={RESTORE_MODAL}
                        command="--show"
                        onClick={() => setRestoreTarget({ versionId: v.id, which: "written", html: v.descriptionHtml })}
                      >
                        Restore
                      </s-button>
                    )}
                    {index === 0 && v.previousDescriptionHtml && props.canWrite && (
                      <s-button
                        variant="tertiary"
                        disabled={busy}
                        commandFor={RESTORE_MODAL}
                        command="--show"
                        onClick={() => setRestoreTarget({ versionId: v.id, which: "previous", html: v.previousDescriptionHtml! })}
                      >
                        Restore what it replaced
                      </s-button>
                    )}
                  </s-stack>
                </s-list-item>
              ))}
            </s-unordered-list>
            <s-modal id={RESTORE_MODAL} heading="Restore this description?" size="large">
              <s-stack gap="base">
                <s-paragraph>
                  The current Shopify description will be replaced by the text below. This creates a new version;
                  nothing in the history is deleted.
                </s-paragraph>
                <s-box padding="base" border="base" borderRadius="base" background="subdued">
                  <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(restoreTarget?.html ?? "") }} />
                </s-box>
              </s-stack>
              <s-button slot="secondary-actions" commandFor={RESTORE_MODAL} command="--hide">
                Cancel
              </s-button>
              <s-button
                slot="primary-action"
                variant="primary"
                disabled={!restoreTarget || busy}
                commandFor={RESTORE_MODAL}
                command="--hide"
                onClick={() => restoreTarget && send("restore", { versionId: String(restoreTarget.versionId), which: restoreTarget.which })}
              >
                Restore in Shopify
              </s-button>
            </s-modal>
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

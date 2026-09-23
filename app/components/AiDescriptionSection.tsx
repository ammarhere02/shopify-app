/**
 * Purpose: The AI description workspace on the product page (generate, review, apply, publish, restore).
 * Called by: routes/app.products.$id.tsx, rendered for every product that still exists in Shopify.
 * Input: Product id, allowed models, the product's Shopify images, the latest job, history, versions, granted scopes,
 *        plus the page's own left-column cards (badge editor, product details) as React nodes.
 * Output: Form posts to /app/products/:id/generation and polls it while a job runs.
 * Uses: The generation resource route only; the browser-side sanitizer for the preview.
 * Does not: Touch the database or Shopify directly, or see any secret.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { useFetcher } from "react-router";
import type { GenerationActionResult, GenerationLoaderData } from "../routes/app.products.$id_.generation";
import type { VersionView } from "../services/description-apply.server";
import { aiStatusLabel, isGenerationFinished } from "../services/generation-view";
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
  productTitle: string;
  /** Small badges for the product panel header (status, badge state). */
  statusBadges?: ReactNode;
  /** Page-owned content for the left panel's collapsible sections. */
  badgeEditor?: ReactNode;
  badgeHint?: string;
  productDetails?: ReactNode;
  /** Page-level result banner (top of the page): success fades out, errors stay. */
  onNotice: (tone: "success" | "critical", message: string) => void;
};

type Intent =
  | "generate"
  | "regenerate"
  | "saveDraft"
  | "approve"
  | "reject"
  | "reopen"
  | "apply"
  | "restore"
  | "publish";

const APPLY_MODAL = "ai-apply-confirm";
const PUBLISH_MODAL = "ai-publish-confirm";
const RESTORE_MODAL = "ai-restore-confirm";
/** Intents whose answer brings a different text into the editor. Every other answer keeps what the merchant typed. */
const REPLACES_DRAFT = new Set<Intent>(["generate", "regenerate", "restore"]);

const pretty = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
const when = (iso: string) => new Date(iso).toLocaleString();

/** One key per intended generation: a retried submit reuses it, the next click gets a new one. */
const newKey = () => crypto.randomUUID();

/**
 * Polaris web components ship no tab component, so this is a small WAI-ARIA tab strip:
 * role=tablist / tab / tabpanel, arrow keys, Home and End move the selection, Tab leaves the strip.
 * Styled by the scoped rules in TAB_CSS (class prefix eh-), nothing global.
 */
const TAB_CSS = `
.eh-tabs{display:flex;gap:2px;border-bottom:1px solid rgba(0,0,0,.1);margin:0;padding:0 16px;overflow-x:auto;flex:none}
.eh-tabs button{appearance:none;background:none;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;padding:10px 10px;font:inherit;font-size:13px;color:rgba(0,0,0,.6);cursor:pointer;white-space:nowrap}
.eh-tabs button:hover{color:rgba(0,0,0,.9)}
.eh-tabs button[aria-selected="true"]{color:rgba(0,0,0,.95);border-bottom-color:currentColor;font-weight:600}
.eh-tabs button:focus-visible{outline:2px solid #005bd3;outline-offset:-2px}
.eh-rich{font-size:14px;line-height:1.55;color:rgba(0,0,0,.85)}
.eh-rich>:first-child{margin-top:0}.eh-rich>:last-child{margin-bottom:0}
.eh-rich h2,.eh-rich h3,.eh-rich h4{font-size:15px;margin:12px 0 4px}
.eh-fade{animation:eh-fade .3s ease-out}
@keyframes eh-fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.eh-skeleton{display:grid;gap:10px;padding:4px 0}
.eh-skeleton span{display:block;height:12px;border-radius:6px;background:linear-gradient(90deg,rgba(0,0,0,.06) 25%,rgba(0,0,0,.12) 50%,rgba(0,0,0,.06) 75%);background-size:200% 100%;animation:eh-shimmer 1.4s linear infinite}
@keyframes eh-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
.eh-preview{border-radius:8px;transition:box-shadow .25s ease}
.eh-preview[data-live="true"]{box-shadow:0 0 0 2px rgba(0,91,211,.35)}
.eh-live{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:rgba(0,0,0,.6)}
.eh-live i{width:7px;height:7px;border-radius:50%;background:rgba(0,0,0,.25)}
.eh-live[data-live="true"] i{background:#005bd3;animation:eh-blink .9s ease-in-out infinite}
@keyframes eh-blink{50%{opacity:.25}}

/* Workspace: fills the app viewport on wide screens, each panel scrolls on its own; plain flow below 760px. */
.eh-layout{container-type:inline-size;container-name:eh-page}
.eh-cols{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;align-items:start}
.eh-col{display:grid;gap:16px;min-width:0}
.eh-work{container-type:inline-size;container-name:eh-work;min-width:0;display:grid;gap:16px}
@container eh-page (min-width: 760px){
  .eh-cols{grid-template-columns:300px minmax(0,1fr);height:calc(100dvh - 150px);min-height:560px}
  .eh-col{height:100%;overflow:auto;align-content:start;padding-right:2px}
  .eh-work{height:100%;grid-template-rows:minmax(0,1fr) auto;min-height:0}
  .eh-panel--desc{min-height:0}
  .eh-panel--hist{max-height:38%}
}
.eh-panel{background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:12px;box-shadow:0 1px 2px rgba(0,0,0,.04);display:flex;flex-direction:column;min-height:0}
.eh-panel__head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid rgba(0,0,0,.08);flex:none;flex-wrap:wrap}
.eh-panel__title{font-size:13px;font-weight:600;color:rgba(0,0,0,.9)}
.eh-panel__body{padding:16px;overflow:auto;min-height:0;flex:1 1 auto}
.eh-panel__body--flush{padding:0}
.eh-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}

/* Collapsible section inside the left panel */
.eh-acc{border-top:1px solid rgba(0,0,0,.08)}
.eh-acc>button{appearance:none;width:100%;background:none;border:0;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:8px;font:inherit;font-size:13px;font-weight:600;color:rgba(0,0,0,.9);cursor:pointer;text-align:left}
.eh-acc>button:hover{background:rgba(0,0,0,.03)}
.eh-acc>button:focus-visible{outline:2px solid #005bd3;outline-offset:-2px}
.eh-acc__chev{width:16px;height:16px;flex:none;transition:transform .2s ease;opacity:.6}
.eh-acc[data-open="true"] .eh-acc__chev{transform:rotate(180deg)}
.eh-acc__hint{font-weight:400;color:rgba(0,0,0,.55);font-size:12px;margin-left:auto}
.eh-acc__body{padding:0 16px 16px}

/* Gallery: selected images feed the writer */
.eh-hero{position:relative;aspect-ratio:1/1;background:#f6f6f7;border-radius:12px 12px 0 0;overflow:hidden}
.eh-hero img{width:100%;height:100%;object-fit:cover;display:block}
.eh-hero__empty{position:absolute;inset:0;display:grid;place-items:center;color:rgba(0,0,0,.5);font-size:13px;padding:16px;text-align:center}
.eh-thumbs{display:flex;gap:8px;padding:12px 16px;overflow-x:auto}
.eh-thumb{appearance:none;flex:none;width:56px;height:56px;padding:0;border:2px solid transparent;border-radius:8px;overflow:hidden;background:#f6f6f7;cursor:pointer;position:relative;opacity:.7;transition:opacity .15s,border-color .15s}
.eh-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.eh-thumb[aria-pressed="true"]{border-color:#303030;opacity:1}
.eh-thumb:hover{opacity:1}
.eh-thumb:focus-visible{outline:2px solid #005bd3;outline-offset:2px}
.eh-thumb__tick{position:absolute;top:3px;right:3px;width:16px;height:16px;border-radius:50%;background:#303030;color:#fff;display:grid;place-items:center;font-size:10px;line-height:1}
.eh-thumb:disabled{cursor:not-allowed;opacity:.35}
.eh-meta{padding:12px 16px 4px;display:flex;flex-direction:column;gap:6px}
.eh-kv{display:grid;grid-template-columns:minmax(0,1fr);gap:6px 12px}
@container eh-work (min-width: 560px){.eh-kv{grid-template-columns:140px minmax(0,1fr)}}
.eh-split{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
@container eh-work (min-width: 720px){.eh-split{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
@media (prefers-reduced-motion:reduce){.eh-fade,.eh-skeleton span,.eh-live i,.eh-acc__chev{animation:none;transition:none}}
`;

function Tabs<T extends string>(props: { label: string; tabs: { id: T; label: string }[]; value: T; onChange: (id: T) => void }) {
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = props.tabs.length - 1;
    const next = e.key === "ArrowRight" ? (index === last ? 0 : index + 1) : e.key === "ArrowLeft" ? (index === 0 ? last : index - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    props.onChange(props.tabs[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div className="eh-tabs" role="tablist" aria-label={props.label}>
      {props.tabs.map((tab, index) => (
        <button
          key={tab.id}
          ref={(el) => {
            refs.current[index] = el;
          }}
          type="button"
          role="tab"
          id={`${base}-${tab.id}`}
          aria-selected={props.value === tab.id}
          aria-controls={`${base}-${tab.id}-panel`}
          tabIndex={props.value === tab.id ? 0 : -1}
          onClick={() => props.onChange(tab.id)}
          onKeyDown={(e) => onKey(e, index)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

const Chevron = () => (
  <svg className="eh-acc__chev" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Collapsible section of the left panel: a real button with aria-expanded, so it works with the keyboard. */
function Collapse(props: { title: string; hint?: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const id = useId();
  return (
    <div className="eh-acc" data-open={open}>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        {props.title}
        {props.hint && <span className="eh-acc__hint">{props.hint}</span>}
        <Chevron />
      </button>
      {open && (
        <div className="eh-acc__body eh-fade" id={id}>
          {props.children}
        </div>
      )}
    </div>
  );
}

const Panel = (props: { id: string; children: ReactNode }) => (
  <div role="tabpanel" id={props.id} tabIndex={0} className="eh-fade">
    {props.children}
  </div>
);

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
  // View state only: never touched by a poll or an action answer, so it stays where the merchant put it.
  const [tab, setTab] = useState<"description" | "html" | "seo">("description");
  const [historyTab, setHistoryTab] = useState<"generations" | "versions">("generations");
  const [detailsOpen, setDetailsOpen] = useState(false);
  // True while the merchant is typing (cleared 700 ms after the last keystroke): drives the preview highlight only.
  const [typing, setTyping] = useState(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idempotencyKey = useRef(newKey());
  const lastIntent = useRef<Intent | null>(null);

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
  // The editor text is replaced only when a different job (or a restored text) arrives; a Save draft
  // or Approve answer must not undo what the merchant typed while the request was in flight.
  useEffect(() => {
    const data = actions.data;
    if (!data?.ok) return;
    idempotencyKey.current = newKey();
    if (data.job) {
      const replaces = REPLACES_DRAFT.has(lastIntent.current!) || data.job.id !== job?.id;
      showJob(data.job);
      if (replaces) setDraft(data.job.draftHtml ?? "");
    }
    if (data.versions) setVersions(data.versions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions.data]);

  // Every finished action reports to the page banner at the top: success fades out, errors stay.
  // The STALE case keeps its own explanatory banner in the workspace as well.
  const { onNotice } = props;
  useEffect(() => {
    if (actions.state !== "idle" || !actions.data) return;
    onNotice(actions.data.ok ? "success" : "critical", actions.data.message);
  }, [actions.state, actions.data, onNotice]);

  // Poll result: a plain read, so a lost or repeated poll changes nothing. The editor is only
  // (re)filled when a job finishes or another job is opened from the history.
  useEffect(() => {
    const next = poll.data && "job" in poll.data ? poll.data.job : null;
    if (!next) return;
    const other = next.id !== job?.id;
    showJob(next);
    if (other || isGenerationFinished(next.status)) setDraft(next.draftHtml ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Live preview: the same sanitizer the server applies, on every keystroke, no request.
  const preview = useMemo(() => sanitizeHtml(draft), [draft]);
  const words = useMemo(() => preview.replace(/<[^>]+>/g, " ").trim().split(/\s+/).filter(Boolean).length, [preview]);
  const onType = (value: string) => {
    setDraft(value);
    setTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => setTyping(false), 700);
  };
  useEffect(() => () => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
  }, []);
  const busy = actions.state !== "idle";
  // Only the button that was clicked spins; the others are disabled until the answer arrives.
  const pending = (busy ? actions.formData?.get("intent") : null) as Intent | null;
  const result = actions.data;
  const errors: Record<string, string> = result && !result.ok ? result.errors : {};

  const send = (intent: Intent, fields: Record<string, string> = {}, mediaIds: string[] = []) => {
    lastIntent.current = intent;
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
  const edited = Boolean(job?.generated && draft !== job.generated.descriptionHtml);
  const mainStatus = aiStatusLabel(job);
  const panelBase = useId();
  const hero = images.find((i) => i.id === selected[selected.length - 1]) ?? images[0] ?? null;

  return (
    <>
      <style>{TAB_CSS}</style>
      <div className="eh-layout">
      <div className="eh-cols">
        {/* ---- Left panel: product, images, inputs, badge, channels, details ---- */}
        <div className="eh-col">
          <div className="eh-panel">
            <div className="eh-hero">
              {hero ? <img src={hero.url} alt={hero.alt ?? props.productTitle} /> : <div className="eh-hero__empty">No ready images in Shopify. Add one to the product to generate from it.</div>}
            </div>
            {images.length > 0 && (
              <div className="eh-thumbs" role="group" aria-label={`Images for the writer, ${selected.length} of ${maxImages} selected`}>
                {images.map((image, index) => {
                  const on = selected.includes(image.id);
                  return (
                    <button
                      key={image.id}
                      type="button"
                      className="eh-thumb"
                      aria-pressed={on}
                      aria-label={`Image ${index + 1}${on ? ", selected" : ""}`}
                      disabled={busy || running || (!on && selected.length >= maxImages)}
                      onClick={() => toggle(image.id, !on)}
                    >
                      <img src={image.url} alt="" />
                      {on && <span className="eh-thumb__tick" aria-hidden="true">✓</span>}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="eh-meta">
              <s-stack direction="inline" gap="small" alignItems="center">{props.statusBadges}</s-stack>
              <s-text color="subdued">
                {images.length === 0 ? "No images selected." : `${selected.length} of ${maxImages} images go to the writer.`}
              </s-text>
              {errors.mediaIds && <s-text tone="critical">{errors.mediaIds}</s-text>}
              {props.imagesError && <s-text tone="warning">{props.imagesError}</s-text>}
            </div>

            <Collapse title="Generate" hint={configured ? undefined : "not configured"} defaultOpen>
              <s-stack gap="small">
                {!configured && <s-banner tone="warning">Set OPENROUTER_API_KEY and OPENROUTER_MODELS on the server.</s-banner>}
                <s-text-area
                  label="Facts for the writer (optional)"
                  details="Audience, tone, material, benefits, keywords."
                  value={context}
                  rows={2}
                  maxLength={CONTEXT_MAX}
                  disabled={busy || running}
                  error={errors.merchantContext}
                  onInput={(e) => setContext(e.currentTarget.value)}
                />
                {models.length > 1 && (
                  <s-select label="Model" value={model} disabled={busy || running} error={errors.model} onChange={(e) => setModel(e.currentTarget.value)}>
                    {models.map((m) => (
                      <s-option key={m} value={m}>
                        {m}
                      </s-option>
                    ))}
                  </s-select>
                )}
                <s-button variant={job ? "secondary" : "primary"} disabled={!canGenerate} loading={pending === "generate"} onClick={() => generate("generate")}>
                  {job ? "Generate new draft" : "Generate description"}
                </s-button>
                <s-text color="subdued">Never changes your Shopify product until you apply.</s-text>
              </s-stack>
            </Collapse>

            {props.badgeEditor && (
              <Collapse title="Storefront badge" hint={props.badgeHint} defaultOpen>
                {props.badgeEditor}
              </Collapse>
            )}

            {props.canPublish && (
              <Collapse title="Sales channels">
                <s-stack gap="small">
                  <s-text color="subdued">Applying saves the text to the product. Publishing makes the product visible on a channel.</s-text>
                  <s-button disabled={busy} loading={pending === "publish"} commandFor={PUBLISH_MODAL} command="--show" onClick={() => channels.load(`${endpoint}?publications=1`)}>
                    Publish to a channel…
                  </s-button>
                </s-stack>
                <s-modal id={PUBLISH_MODAL} heading="Publish this product?">
                  <s-stack gap="base">
                    {channels.state !== "idle" && (
                      <s-stack direction="inline" gap="small" alignItems="center">
                        <s-spinner size="base" accessibilityLabel="Loading sales channels" />
                        <s-text>Loading sales channels…</s-text>
                      </s-stack>
                    )}
                    {publicationsError && <s-banner tone="critical">{publicationsError}</s-banner>}
                    {liveStatus !== "ACTIVE" && (
                      <s-banner tone="warning">The product is {pretty(liveStatus)}. Shopify only shows Active products, so set it to Active in Shopify first.</s-banner>
                    )}
                    {publications.length > 0 && (
                      <s-select label="Sales channel" value={publicationId} error={errors.publicationId} onChange={(e) => setPublicationId(e.currentTarget.value)}>
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
              </Collapse>
            )}

            {props.productDetails && <Collapse title="Product details">{props.productDetails}</Collapse>}
          </div>
        </div>

        {/* ---- Right: description panel (scrolls inside) + history panel ---- */}
        <div className="eh-work">
          <div className="eh-panel eh-panel--desc">
            <div className="eh-panel__head">
              <s-stack direction="inline" gap="small" alignItems="center">
                <span className="eh-panel__title">Description</span>
                <s-badge tone={mainStatus.tone}>{mainStatus.label}</s-badge>
                {running && <s-spinner size="base" accessibilityLabel="Generating" />}
                {edited && isDraft && <s-badge tone="info">Unsaved edits</s-badge>}
                {job && <s-text color="subdued">#{job.id}</s-text>}
              </s-stack>
              {job && !running && (
                <div className="eh-actions">
                  {isDraft && (
                    <>
                      <s-button variant="tertiary" tone="critical" disabled={busy} loading={pending === "reject"} onClick={() => review("reject")}>
                        Reject
                      </s-button>
                      <s-button variant="tertiary" disabled={!canGenerate} loading={pending === "regenerate"} onClick={() => generate("regenerate")}>
                        Regenerate
                      </s-button>
                      <s-button disabled={busy} loading={pending === "saveDraft"} onClick={() => review("saveDraft")}>
                        Save draft
                      </s-button>
                      <s-button variant="primary" disabled={busy} loading={pending === "approve"} onClick={() => review("approve")}>
                        Approve
                      </s-button>
                    </>
                  )}
                  {job.reviewStatus === "APPROVED" && (
                    <>
                      <s-button variant="tertiary" disabled={!canGenerate} loading={pending === "regenerate"} onClick={() => generate("regenerate")}>
                        Regenerate
                      </s-button>
                      <s-button disabled={busy} loading={pending === "reopen"} onClick={() => review("reopen")}>
                        Edit again
                      </s-button>
                      <s-button variant="primary" disabled={busy || !props.canWrite} loading={pending === "apply"} commandFor={APPLY_MODAL} command="--show">
                        Apply to product…
                      </s-button>
                    </>
                  )}
                  {(job.reviewStatus === "APPLIED" || job.reviewStatus === "REJECTED" || job.status === "FAILED") && (
                    <s-button variant={job.reviewStatus === "APPLIED" ? "secondary" : "primary"} disabled={!canGenerate} loading={pending === "regenerate"} onClick={() => generate("regenerate")}>
                      Regenerate
                    </s-button>
                  )}
                </div>
              )}
            </div>

            {job?.status === "SUCCEEDED" && (
              <Tabs
                label="Description views"
                value={tab}
                onChange={setTab}
                tabs={[
                  { id: "description", label: "Description" },
                  { id: "html", label: isDraft ? "Edit HTML" : "HTML" },
                  { id: "seo", label: "SEO suggestions" },
                ]}
              />
            )}

            <div className="eh-panel__body">
              <s-stack gap="base">
                {result && !result.ok && result.code === "STALE" && (
                  <s-banner tone="critical" heading="The product changed in Shopify">
                    Someone edited this product&apos;s description after this text was generated. Reload the page to see the current text, or regenerate from it.
                  </s-banner>
                )}
                {job?.reviewStatus === "APPROVED" && !props.canWrite && (
                  <s-banner tone="warning">
                    This store has not granted the app permission to write products yet. Reload the app from Shopify admin and accept the new permission, then come back here.
                  </s-banner>
                )}
                {job?.error && job.reviewStatus === "APPROVED" && <s-banner tone="warning">{job.error}</s-banner>}
                {job?.status === "FAILED" && (
                  <s-banner tone="critical" heading="Generation failed">
                    {job.error ?? "Unknown error"}. Nothing was changed. You can regenerate.
                  </s-banner>
                )}
                {job?.reviewStatus === "APPLYING" && (
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-spinner size="base" accessibilityLabel="Writing to Shopify" />
                    <s-text>Writing to Shopify…</s-text>
                  </s-stack>
                )}
                {job && job.warnings.length > 0 && (
                  <s-banner tone="warning" heading="Check before approving">
                    <s-unordered-list>
                      {job.warnings.map((warning) => (
                        <s-list-item key={warning}>{warning}</s-list-item>
                      ))}
                    </s-unordered-list>
                  </s-banner>
                )}

                {!job && (
                  <s-box padding="large" border="base" borderStyle="dashed" borderRadius="base">
                    <s-stack gap="small-200" alignItems="center">
                      <s-text type="strong">No description yet</s-text>
                      <s-text color="subdued">Choose images on the left, add facts if you have them, and generate. The draft appears here for review.</s-text>
                    </s-stack>
                  </s-box>
                )}
                {running && (
                  <div className="eh-skeleton" aria-busy="true" aria-label="Writing the description">
                    <span style={{ width: "92%" }} />
                    <span style={{ width: "100%" }} />
                    <span style={{ width: "78%" }} />
                    <span style={{ width: "60%", marginTop: 6 }} />
                    <span style={{ width: "66%" }} />
                    <span style={{ width: "54%" }} />
                  </div>
                )}
                {running && <s-text color="subdued">Writing the description. Usually 5 to 30 seconds; this panel updates by itself.</s-text>}

                {job?.status === "SUCCEEDED" && tab === "description" && (
                  <Panel id={`${panelBase}-description-panel`}>
                    {/* Safe: `preview` went through the same allowlist sanitizer the server uses. */}
                    <div className="eh-rich" dangerouslySetInnerHTML={{ __html: preview || "<p><em>Empty description.</em></p>" }} />
                  </Panel>
                )}
                {job?.status === "SUCCEEDED" && tab === "html" && (
                  <Panel id={`${panelBase}-html-panel`}>
                    <s-stack gap="small">
                      <div className="eh-split">
                        <s-text-area
                          label="Description HTML"
                          details="Allowed: p, h2-h4, ul, ol, li, strong, em, br. Anything else is removed when saved."
                          value={draft}
                          rows={12}
                          maxLength={HTML_MAX}
                          readOnly={!isDraft}
                          error={errors.descriptionHtml}
                          onInput={(e) => onType(e.currentTarget.value)}
                        />
                        <s-stack gap="small-200">
                          <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
                            <s-text type="strong">Preview</s-text>
                            <span className="eh-live" data-live={typing} aria-live="polite">
                              <i aria-hidden="true" />
                              {typing ? "Updating" : `${words} words`}
                            </span>
                          </s-stack>
                          <div className="eh-preview" data-live={typing}>
                            <s-box padding="base" border="base" borderRadius="base" background="subdued">
                              <div className="eh-rich" dangerouslySetInnerHTML={{ __html: preview }} />
                            </s-box>
                          </div>
                        </s-stack>
                      </div>
                      {!isDraft && <s-text color="subdued">Read-only in this state. Use Edit again (approved) or Regenerate to change the text.</s-text>}
                      {isDraft && edited && (
                        <s-button variant="tertiary" disabled={busy} onClick={() => setDraft(job.generated!.descriptionHtml)}>
                          Reset to generated text
                        </s-button>
                      )}
                    </s-stack>
                  </Panel>
                )}
                {job?.status === "SUCCEEDED" && tab === "seo" && job.generated && (
                  <Panel id={`${panelBase}-seo-panel`}>
                    <s-stack gap="small">
                      <s-text color="subdued">Suggestions only. They are shown here and never written to Shopify.</s-text>
                      <div className="eh-kv">
                        <s-text color="subdued">SEO title</s-text>
                        <s-text>{job.generated.seoTitle}</s-text>
                        <s-text color="subdued">SEO description</s-text>
                        <s-text>{job.generated.seoDescription}</s-text>
                        <s-text color="subdued">Short description</s-text>
                        <s-text>{job.generated.shortDescription}</s-text>
                        {job.generated.highlights.length > 0 && (
                          <>
                            <s-text color="subdued">Highlights</s-text>
                            <s-unordered-list>
                              {job.generated.highlights.map((h) => (
                                <s-list-item key={h}>{h}</s-list-item>
                              ))}
                            </s-unordered-list>
                          </>
                        )}
                      </div>
                    </s-stack>
                  </Panel>
                )}

                {job && (
                  <s-stack gap="small-200">
                    <s-button variant="tertiary" onClick={() => setDetailsOpen((v) => !v)} accessibilityLabel={`${detailsOpen ? "Hide" : "Show"} generation details`}>
                      {detailsOpen ? "Hide generation details" : "Generation details"}
                    </s-button>
                    {detailsOpen && (
                      <div className="eh-kv eh-fade">
                        <s-text color="subdued">Generation</s-text>
                        <s-text>#{job.id}{job.previousGenerationId ? ` (regenerated from #${job.previousGenerationId})` : ""}</s-text>
                        <s-text color="subdued">State</s-text>
                        <s-text>
                          {pretty(job.status)}
                          {job.reviewStatus ? ` · review ${pretty(job.reviewStatus)}` : ""}
                        </s-text>
                        <s-text color="subdued">Model</s-text>
                        <s-text>{job.model}</s-text>
                        <s-text color="subdued">Prompt</s-text>
                        <s-text>{job.promptVersion}</s-text>
                        <s-text color="subdued">Tokens</s-text>
                        <s-text>{job.usage ? `${job.usage.promptTokens ?? "?"} in / ${job.usage.completionTokens ?? "?"} out` : "—"}</s-text>
                        <s-text color="subdued">Latency</s-text>
                        <s-text>{job.usage ? `${(job.usage.latencyMs / 1000).toFixed(1)} s` : "—"}</s-text>
                        <s-text color="subdued">Cost</s-text>
                        <s-text>{job.usage ? (job.usage.estimatedCostUsd === null ? "not reported" : `$${job.usage.estimatedCostUsd.toFixed(6)}`) : "—"}</s-text>
                        <s-text color="subdued">Provider ID</s-text>
                        <s-text>{job.usage?.generationId ?? "—"}</s-text>
                        <s-text color="subdued">Created</s-text>
                        <s-text>{when(job.createdAt)}</s-text>
                      </div>
                    )}
                  </s-stack>
                )}
              </s-stack>
            </div>

            <s-modal id={APPLY_MODAL} heading="Replace the product description?" size="large">
              <s-stack gap="base">
                <s-paragraph>
                  The current description in Shopify will be replaced by the approved text. The previous text is kept in History and can be restored.
                </s-paragraph>
                <div className="eh-split">
                  <s-stack gap="small-200">
                    <s-text type="strong">Previous (last known)</s-text>
                    <s-box padding="base" border="base" borderRadius="base" background="subdued">
                      <div className="eh-rich" dangerouslySetInnerHTML={{ __html: sanitizeHtml(versions[0]?.descriptionHtml ?? "") || "<p><em>Not recorded by this app yet.</em></p>" }} />
                    </s-box>
                  </s-stack>
                  <s-stack gap="small-200">
                    <s-text type="strong">New</s-text>
                    <s-box padding="base" border="base" borderRadius="base">
                      <div className="eh-rich" dangerouslySetInnerHTML={{ __html: preview }} />
                    </s-box>
                  </s-stack>
                </div>
              </s-stack>
              <s-button slot="secondary-actions" commandFor={APPLY_MODAL} command="--hide">
                Cancel
              </s-button>
              <s-button slot="primary-action" variant="primary" loading={pending === "apply"} disabled={busy} commandFor={APPLY_MODAL} command="--hide" onClick={() => review("apply")}>
                Apply to Shopify
              </s-button>
            </s-modal>
          </div>

          <div className="eh-panel eh-panel--hist">
            <div className="eh-panel__head">
              <span className="eh-panel__title">History</span>
            </div>
            <Tabs
              label="History views"
              value={historyTab}
              onChange={setHistoryTab}
              tabs={[
                { id: "generations", label: `Generations (${history.length})` },
                { id: "versions", label: `Written to Shopify (${versions.length})` },
              ]}
            />
            <div className="eh-panel__body eh-panel__body--flush">
              {historyTab === "generations" && (
                <Panel id={`${panelBase}-generations-panel`}>
                  {history.length === 0 ? (
                    <s-box padding="base">
                      <s-text color="subdued">No generations yet.</s-text>
                    </s-box>
                  ) : (
                    <s-table>
                      <s-table-header-row>
                        <s-table-header listSlot="primary">Generation</s-table-header>
                        <s-table-header listSlot="secondary">Created</s-table-header>
                        <s-table-header listSlot="labeled">Model</s-table-header>
                        <s-table-header listSlot="inline">Status</s-table-header>
                        <s-table-header listSlot="inline">Actions</s-table-header>
                      </s-table-header-row>
                      <s-table-body>
                        {history.map((item) => {
                          const status = aiStatusLabel(item);
                          return (
                            <s-table-row key={item.id}>
                              <s-table-cell>#{item.id}</s-table-cell>
                              <s-table-cell>{when(item.createdAt)}</s-table-cell>
                              <s-table-cell>{item.model}</s-table-cell>
                              <s-table-cell>
                                <s-badge tone={status.tone}>{status.label}</s-badge>
                              </s-table-cell>
                              <s-table-cell>
                                {item.id === job?.id ? (
                                  <s-text color="subdued">Open</s-text>
                                ) : (
                                  <s-button variant="tertiary" disabled={busy} onClick={() => poll.load(`${endpoint}?jobId=${item.id}`)}>
                                    View
                                  </s-button>
                                )}
                              </s-table-cell>
                            </s-table-row>
                          );
                        })}
                      </s-table-body>
                    </s-table>
                  )}
                </Panel>
              )}
              {historyTab === "versions" && (
                <Panel id={`${panelBase}-versions-panel`}>
                  {versions.length === 0 ? (
                    <s-box padding="base">
                      <s-text color="subdued">This app has not written a description to Shopify yet.</s-text>
                    </s-box>
                  ) : (
                    <s-table>
                      <s-table-header-row>
                        <s-table-header listSlot="primary">Version</s-table-header>
                        <s-table-header listSlot="secondary">Applied</s-table-header>
                        <s-table-header listSlot="labeled">Source</s-table-header>
                        <s-table-header listSlot="labeled">By</s-table-header>
                        <s-table-header listSlot="inline">Actions</s-table-header>
                      </s-table-header-row>
                      <s-table-body>
                        {versions.map((v, index) => (
                          <s-table-row key={v.id}>
                            <s-table-cell>
                              <s-stack direction="inline" gap="small" alignItems="center">
                                <s-text>v{v.id}</s-text>
                                {index === 0 && <s-badge tone="success">Current</s-badge>}
                              </s-stack>
                            </s-table-cell>
                            <s-table-cell>{when(v.appliedAt)}</s-table-cell>
                            <s-table-cell>{v.source === "RESTORE" ? `Restored from v${v.restoredFromVersionId}` : `Generation #${v.generationId}`}</s-table-cell>
                            <s-table-cell>{v.appliedBy.replace(/^admin:/, "")}</s-table-cell>
                            <s-table-cell>
                              <s-stack direction="inline" gap="small">
                                {index > 0 && props.canWrite && (
                                  <s-button variant="tertiary" disabled={busy} commandFor={RESTORE_MODAL} command="--show" onClick={() => setRestoreTarget({ versionId: v.id, which: "written", html: v.descriptionHtml })}>
                                    Restore
                                  </s-button>
                                )}
                                {index === 0 && v.previousDescriptionHtml && props.canWrite && (
                                  <s-button variant="tertiary" disabled={busy} commandFor={RESTORE_MODAL} command="--show" onClick={() => setRestoreTarget({ versionId: v.id, which: "previous", html: v.previousDescriptionHtml! })}>
                                    Restore what it replaced
                                  </s-button>
                                )}
                              </s-stack>
                            </s-table-cell>
                          </s-table-row>
                        ))}
                      </s-table-body>
                    </s-table>
                  )}
                </Panel>
              )}
            </div>
            <s-modal id={RESTORE_MODAL} heading="Restore this description?" size="large">
              <s-stack gap="base">
                <s-paragraph>The current Shopify description will be replaced by the text below. This creates a new version; nothing in the history is deleted.</s-paragraph>
                <s-box padding="base" border="base" borderRadius="base" background="subdued">
                  <div className="eh-rich" dangerouslySetInnerHTML={{ __html: sanitizeHtml(restoreTarget?.html ?? "") }} />
                </s-box>
              </s-stack>
              <s-button slot="secondary-actions" commandFor={RESTORE_MODAL} command="--hide">
                Cancel
              </s-button>
              <s-button
                slot="primary-action"
                variant="primary"
                disabled={!restoreTarget || busy}
                loading={pending === "restore"}
                commandFor={RESTORE_MODAL}
                command="--hide"
                onClick={() => restoreTarget && send("restore", { versionId: String(restoreTarget.versionId), which: restoreTarget.which })}
              >
                Restore in Shopify
              </s-button>
            </s-modal>
          </div>
        </div>
      </div>
      </div>
    </>
  );
}

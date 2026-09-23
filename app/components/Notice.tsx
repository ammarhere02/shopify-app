/**
 * Purpose: One page-level result banner, shown at the top of the page after an action finishes.
 * Called by: app.products.$id.tsx, app.products._index.tsx, app.sync.tsx (and the AI workspace through onNotice).
 * Input: tone + message from useNotice; success notices fade out after NOTICE_MS, others stay until dismissed.
 * Output: An s-banner at the top of the page, or nothing.
 * Does not: Know about fetchers or intents; the page decides what is worth a notice.
 */
import { useCallback, useEffect, useState } from "react";

export const NOTICE_MS = 5000;

export type NoticeTone = "success" | "critical" | "warning" | "info";
export type NoticeState = { tone: NoticeTone; message: string; id: number } | null;

export function useNotice() {
  const [notice, setNotice] = useState<NoticeState>(null);
  const show = useCallback((tone: NoticeTone, message: string) => setNotice({ tone, message, id: Date.now() }), []);
  const clear = useCallback(() => setNotice(null), []);
  // Success is transient; anything that needs action stays until the merchant closes it or acts again.
  useEffect(() => {
    if (!notice || notice.tone !== "success") return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  return { notice, show, clear };
}

const CSS = `
.eh-notice{animation:eh-notice-in .25s ease-out}
@keyframes eh-notice-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.eh-notice{animation:none}}
`;

export function Notice(props: { notice: NoticeState; onDismiss: () => void }) {
  const { notice } = props;
  if (!notice) return null;
  return (
    <div className="eh-notice" key={notice.id} role="status" aria-live="polite">
      <style>{CSS}</style>
      <s-banner tone={notice.tone} dismissible onDismiss={props.onDismiss}>
        {notice.message}
      </s-banner>
    </div>
  );
}

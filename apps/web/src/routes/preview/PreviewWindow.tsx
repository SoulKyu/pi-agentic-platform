import "../../i18n/register-boxes.ts";
import "../../i18n/register-previews.ts";
import type { BoxRef } from "@pap/contracts";
import { Button, InlineError, LoadingLine, PREVIEW_SANDBOX, SandboxedFrame } from "@pap/ui";
import { useEffect, useState, type ReactNode } from "react";
import { usePreviewLease } from "../../features/previews/use-preview-lease.ts";
import { errorKey, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { feedPreviews } from "../../stores/previews-feed.ts";
import { usePreviewsStore, previewKey } from "../../stores/previews-store.ts";

interface Props {
  /** Stable across renders (the lease hook depends on it). */
  readonly box: BoxRef;
  readonly name: string;
}

/**
 * OPEN IN A NEW TAB (UX2-R79, decision 139): the framed preview full-window on pap's own origin, under its UNTRUSTED label.
 * The owner's click in the opener opened it, so it mints on load; the capability URL goes to the frame only, never to the
 * address bar or the history. It reads the `previews` stream itself and closes its lease when the page goes away.
 */
export default function PreviewWindow({ box, name }: Props) {
  const t = useT();
  const [feedFailed, setFeedFailed] = useState(false);
  useEffect(() => {
    const stop = feedPreviews(getRuntime().subscriptions, () => setFeedFailed(true));
    return () => {
      stop();
      usePreviewsStore.getState().reset();
    };
  }, []);
  const ready = usePreviewsStore((state) => state.ready);
  // Mints once the stream has said which service this is, so a restart under another id is told apart; a stream that
  // refuses does not keep the owner from the page.
  const lease = usePreviewLease(box, name, ready || feedFailed);
  const { release } = lease;
  useEffect(() => {
    window.addEventListener("pagehide", release);
    return () => window.removeEventListener("pagehide", release);
  }, [release]);
  const service = usePreviewsStore((state) => state.services.get(previewKey(box, name)));
  const gone = service?.state !== "running" && (lease.state === "gone" || ready);

  let body: ReactNode;
  if (lease.state === "open" && lease.url !== null && !gone) {
    body = (
      <SandboxedFrame
        key={lease.reloads}
        src={lease.url}
        sandbox={PREVIEW_SANDBOX}
        label={t("previews.frame", { name })}
        title={t("previews.frameTitle", { name })}
      />
    );
  } else if (gone) {
    body = <Notice text={t("previews.gone")} />;
  } else if (lease.state === "closed" && lease.error === null) {
    body = <LoadingLine label={t("app.loading")} />;
  } else if (lease.error === "box_stopped") {
    body = (
      <Notice text={t(box.kind === "project" ? "previews.boxStopped" : "previews.agentStopped")}>
        {retry(lease.open, t("previews.open"))}
      </Notice>
    );
  } else {
    body = (
      <Notice text={t(lease.state === "restarted" ? "previews.restarted" : "previews.notOpen")}>
        {lease.error === null ? null : (
          <InlineError announce="action">{t(errorKey(lease.error))}</InlineError>
        )}
        {retry(lease.open, t("previews.open"))}
      </Notice>
    );
  }
  return (
    <main data-preview-window="" className="flex h-screen min-h-0 flex-col gap-s2 bg-bg p-s2">
      {lease.state === "open" ? (
        <div className="flex items-center gap-s2">
          <Button variant="ghost" size="sm" onClick={lease.reload}>
            {t("previews.reload")}
          </Button>
        </div>
      ) : null}
      {lease.lost === null ? null : (
        <InlineError announce="background">{t(errorKey(lease.lost))}</InlineError>
      )}
      {body}
      <p className="text-ui text-muted">{t("previews.cookies")}</p>
    </main>
  );
}

const retry = (onClick: () => void, label: string) => (
  <Button variant="secondary" onClick={onClick}>
    {label}
  </Button>
);

function Notice({ text, children }: { readonly text: string; readonly children?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-start gap-s2 rounded-md border border-dashed border-border p-s3">
      <p className="text-ui text-fg">{text}</p>
      {children}
    </div>
  );
}

import { Button, TextField } from "@pap/ui";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { t } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import type { SessionView } from "../../stores/session-reducer.ts";
import { useAction, type Track } from "./use-action.ts";

/** The contract's limit on a name, counted in code points (a name of 256 emoji is 512 UTF-16 units). */
const NAME_CODE_POINTS = 256;
const clipName = (value: string): string => [...value].slice(0, NAME_CODE_POINTS).join("");

interface SessionActionsProps {
  readonly sessionId: string;
  readonly view: SessionView;
  /** Tells the screen a call is in flight, so Stop stays reachable (default: nobody listens). */
  readonly track?: Track;
  /** True while another structural call of this screen (a row's Edit or Fork) is in flight. */
  readonly blocked?: boolean;
}

const untracked: Track = (call) => call;

/** Starts a download of a same-origin URL the way a click on a link does: a detached anchor, no fetch, no Blob. */
function download(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  anchor.click();
  anchor.remove();
}

export function SessionActions({ sessionId, view, track = untracked, blocked = false }: SessionActionsProps) {
  const runtime = getRuntime();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [draftName, setDraftName] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const root = useRef<HTMLElement | null>(null);
  const rename = useAction(track, setError);
  const autoName = useAction(track, setError);
  const compact = useAction(track, setError);
  const exportHtml = useAction(track, setError);
  const duplicate = useAction(track, setError);

  const cancelRename = () => {
    setDraftName(null);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>("[data-rename]")?.focus());
  };
  const saveRename = async () => {
    const name = (draftName ?? "").trim();
    if (name === "") return;
    const saved = await rename.run(() =>
      runtime.rpc.call(
        "sessions.rename",
        { sessionId, name: clipName(name) },
        { commandId: runtime.rpc.newCommandId() },
      ),
    );
    if (saved) setDraftName(null);
  };
  const startRename = () => {
    setError(null);
    setDraftName(clipName(view.name ?? ""));
    requestAnimationFrame(() => root.current?.querySelector("input")?.focus());
  };

  const compacting = view.activity.compacting;
  return (
    <section ref={root} aria-label={t("actions.label")} data-session-actions className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-2">
        {draftName === null ? (
          <Button data-rename onClick={startRename}>
            {t("actions.rename")}
          </Button>
        ) : (
          <div
            className="flex items-end gap-2"
            onKeyDown={(event) => {
              // Escape in this field cancels the edit only: the page's Escape-to-Stop must not see it.
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancelRename();
              } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void saveRename();
              }
            }}
          >
            <TextField
              label={t("actions.rename")}
              value={draftName}
              onChange={(value) => setDraftName(clipName(value))}
              name="session-name"
            />
            <Button
              variant="primary"
              disabled={rename.busy || draftName.trim() === ""}
              onClick={() => void saveRename()}
            >
              {t("actions.save")}
            </Button>
            <Button onClick={cancelRename}>{t("dialog.cancel")}</Button>
          </div>
        )}
        <Button
          disabled={autoName.busy}
          onClick={() =>
            void autoName.run(() =>
              runtime.rpc.call("sessions.autoName", { sessionId }, { commandId: runtime.rpc.newCommandId() }),
            )
          }
        >
          {autoName.slow ? t("actions.naming") : t("actions.autoName")}
        </Button>
        <Button
          disabled={view.status === "running" || compacting || compact.busy || blocked}
          onClick={() =>
            void compact.run(() =>
              runtime.rpc.call("sessions.compact", { sessionId }, { commandId: runtime.rpc.newCommandId() }),
            )
          }
        >
          {compact.slow ? t("actions.working") : t("actions.compact")}
        </Button>
        {exporting ? null : <Button onClick={() => setExporting(true)}>{t("actions.export")}</Button>}
        <Button
          disabled={duplicate.busy}
          onClick={() =>
            void duplicate.run(async () => {
              const copy = await runtime.rpc.call(
                "sessions.clone",
                { sessionId },
                { commandId: runtime.rpc.newCommandId() },
              );
              await navigate({ to: "/s/$sessionId", params: { sessionId: copy.sessionId } });
            })
          }
        >
          {duplicate.slow ? t("actions.working") : t("actions.duplicate")}
        </Button>
      </div>
      {exporting ? (
        <div role="group" aria-label={t("actions.export")} className="flex flex-wrap items-center gap-2">
          <p className="text-ui text-attention">{t("actions.exportWarning")}</p>
          <Button
            variant="primary"
            disabled={exportHtml.busy}
            onClick={async () => {
              const exported = await exportHtml.run(async () => {
                const { url } = await runtime.rpc.call(
                  "sessions.exportHtml",
                  { sessionId },
                  { commandId: runtime.rpc.newCommandId() },
                );
                download(url);
              });
              if (exported) setExporting(false);
            }}
          >
            {exportHtml.slow ? t("actions.working") : t("actions.download")}
          </Button>
          <Button onClick={() => setExporting(false)}>{t("dialog.cancel")}</Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-ui text-attention">
          {error}
        </p>
      ) : null}
    </section>
  );
}

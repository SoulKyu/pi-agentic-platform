import { Button, TextField } from "@pap/ui";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
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

/**
 * The export is a path on this origin that, once resolved (dot segments and `%2e` folded), is still under
 * `/api/sessions/`; another host, `//host`, a scheme, `..` and a backslash are refused.
 */
function sameOriginExport(url: string): boolean {
  if (!url.startsWith("/") || url.includes("\\")) return false;
  const resolved = new URL(url, location.origin);
  return resolved.origin === location.origin && resolved.pathname.startsWith("/api/sessions/");
}

/**
 * Starts a download the way a click on a link does: no fetch, no Blob, no new tab. The anchor is attached while it is
 * clicked (a click on a detached one after an awaited call is unreliable on iOS Safari) and removed straight after.
 */
function download(url: string): void {
  if (!sameOriginExport(url)) throw new Error("export url refused");
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}

export function SessionActions(props: SessionActionsProps) {
  const t = useT();
  const { sessionId, view } = props;
  const track = props.track ?? untracked;
  const blocked = props.blocked ?? false;
  const runtime = getRuntime();
  const navigate = useNavigate();
  const [draftName, setDraftName] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const root = useRef<HTMLElement | null>(null);
  const rename = useAction(track);
  const autoName = useAction(track);
  const compact = useAction(track);
  const exportHtml = useAction(track);
  const duplicate = useAction(track);

  // The field or its buttons held the focus; the trigger comes back once the screen has drawn it.
  const focusTrigger = () =>
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>("[data-rename]")?.focus());
  const cancelRename = () => {
    setDraftName(null);
    focusTrigger();
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
    if (saved) cancelRename();
  };
  const startRename = () => {
    rename.clear();
    setDraftName(clipName(view.name ?? ""));
    requestAnimationFrame(() => root.current?.querySelector("input")?.focus());
  };

  const compacting = view.activity.compacting;
  return (
    <section ref={root} aria-label={t("actions.label")} data-session-actions className="flex flex-col gap-s2">
      <div className="flex flex-wrap items-start gap-s2">
        {draftName === null ? (
          <Button data-rename onClick={startRename}>
            {t("actions.rename")}
          </Button>
        ) : (
          <div
            data-inline-edit
            className="flex items-end gap-s2"
            onKeyDown={(event) => {
              // Escape in this field cancels the edit only: the page's Escape-to-Stop must not see it.
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancelRename();
              } else if (
                event.key === "Enter" &&
                event.target instanceof HTMLInputElement &&
                !event.nativeEvent.isComposing
              ) {
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
        <div role="group" aria-label={t("actions.export")} className="flex flex-wrap items-center gap-s2">
          <p className="text-ui text-attn">{t("actions.exportWarning")}</p>
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
      {[rename, autoName, compact, exportHtml, duplicate].map((action, index) =>
        action.error ? (
          <p key={index} role="alert" className="text-ui text-attn">
            {action.error}
          </p>
        ) : null,
      )}
    </section>
  );
}

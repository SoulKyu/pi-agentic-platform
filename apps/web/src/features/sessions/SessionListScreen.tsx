import { Button, cn, FOCUS_RING, TextField, useIsPhone } from "@pap/ui";
import { isSnoozed, type ToolPreset } from "@pap/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { formatAge } from "../../i18n/age.ts";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";
import { runCommand } from "../../lib/command-registry.ts";
import { sessionLabel } from "../../lib/session-label.ts";
import { getRuntime, useConnectionState } from "../../runtime/index.ts";
import { useCurrentProject, useEffectiveProject } from "../../stores/current-project.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { failureText } from "./failure.ts";
import { lastPreset, rememberPreset } from "./presets.vm.ts";

// The picker (Select and its strings) is a chunk of its own: the home stays within the initial bundle.
const loadPicker = () => import("./PresetPicker.tsx");

/** The newest sessions "Recent" shows; the whole list is the tree (M4R104). */
const RECENT = 10;

export function SessionListScreen() {
  const t = useT();
  const lazyText = useLazyFailureText();
  const { Lazy: Picker, attempt, retry } = useRetryableLazy(loadPicker);
  const runtime = getRuntime();
  const connection = useConnectionState(runtime.connection);
  const navigate = useNavigate();
  const phone = useIsPhone();
  const project = useEffectiveProject();
  // The folder follows the current project's root until the person types in the field.
  const [typed, setTyped] = useState<string | null>(null);
  // "New session here" is an explicit action: it refills the field even over what the person typed.
  const startedHere = useCurrentProject((state) => state.startedHere);
  const [seenStart, setSeenStart] = useState(startedHere);
  if (seenStart !== startedHere) {
    setSeenStart(startedHere);
    setTyped(null);
  }
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const [preset, setPreset] = useState<ToolPreset>(lastPreset);
  const cwd = typed ?? project?.root ?? "";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const held = useShellStore((state) => state.view.sessions);
  const loaded = useShellStore((state) => state.view.loaded);
  const broken = useShellStore((state) => state.view.unreadable || state.view.failed !== null);
  const projectId = project?.id ?? null;
  const sessions = useMemo(
    () =>
      [...held.values()]
        .filter((session) => session.archivedAt === null && session.settledAt === null)
        .filter((session) => !isSnoozed(session, now))
        .filter((session) => projectId === null || session.projectId === projectId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, RECENT),
    [held, projectId, now],
  );

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { sessionId } = await runtime.rpc.call("sessions.create", { cwd: cwd.trim(), preset });
      await navigate({ to: "/s/$sessionId", params: { sessionId } });
    } catch (failure) {
      // The session may have been made though no answer came (R105): the stream shows it if it was.
      setError(failureText(failure));
    }
    setBusy(false);
  };

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-s4 overflow-y-auto p-s4">
      <h1 className="text-xl font-extrabold text-fg">{t("sessions.title")}</h1>
      <form
        className="flex flex-col gap-s2"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <TextField
          label={t("sessions.cwd")}
          hint={t("sessions.cwdHint")}
          value={cwd}
          onChange={setTyped}
          error={error}
          name="cwd"
        />
        <div className="max-w-64">
          <LazyBoundary
            resetKey={attempt}
            onError={(error) => {
              retry();
              notifyLazyFailure(error, lazyText);
            }}
          >
            <Picker
              value={preset}
              onChange={(next) => {
                setPreset(next);
                rememberPreset(next);
              }}
              disabled={busy}
            />
          </LazyBoundary>
        </div>
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || connection !== "open" || cwd.trim() === ""}
          >
            {t("sessions.create")}
          </Button>
        </div>
      </form>
      {broken ? (
        <div className="flex items-center gap-s2">
          <p role="alert" className="text-ui text-attn">
            {t("shell.tree.error")}
          </p>
          <Button variant="secondary" size="sm" onClick={() => runtime.subscriptions.resync("shell", "me")}>
            {t("shell.tree.retry")}
          </Button>
        </div>
      ) : !loaded ? (
        <p className="text-muted">{t("shell.tree.loading")}</p>
      ) : sessions.length === 0 ? (
        <p className="text-muted">{t("sessions.empty")}</p>
      ) : (
        <>
          <h2 className="label-hud text-muted">{t("sessions.recent")}</h2>
          <ul className="flex flex-col gap-s1">
            {sessions.map((session) => {
              const label = sessionLabel(session) || session.cwd;
              return (
                <li key={session.id} className="flex items-center gap-s2">
                  <div className="flex min-w-0 flex-col">
                    <Link
                      to="/s/$sessionId"
                      params={{ sessionId: session.id }}
                      className={cn("break-all text-fg underline", FOCUS_RING)}
                    >
                      {label}
                    </Link>
                    {label !== session.cwd ? (
                      <span className="break-all text-ui text-muted">{session.cwd}</span>
                    ) : null}
                  </div>
                  <span className="label-hud text-muted">{formatAge(now, session.updatedAt, t)}</span>
                </li>
              );
            })}
          </ul>
          <div>
            <Button
              variant="ghost"
              size="sm"
              // "mobile.lists.open" is registered by MobileShell and only used on a phone.
              onClick={() => void runCommand(phone ? "mobile.lists.open" : "drawer.tree.toggle")}
            >
              {t("sessions.all")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

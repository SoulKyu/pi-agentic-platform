import { Button, cn, FOCUS_RING, TextField } from "@pap/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime, useConnectionState } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { failureText } from "./failure.ts";

/** The most rows this list shows; the full home is the archive and search screens (M4). */
const MAX_LISTED = 50;

export function SessionListScreen() {
  const t = useT();
  const runtime = getRuntime();
  const connection = useConnectionState(runtime.connection);
  const navigate = useNavigate();
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const held = useShellStore((state) => state.view.sessions);
  const loaded = useShellStore((state) => state.view.loaded);
  const broken = useShellStore((state) => state.view.unreadable || state.view.failed !== null);
  const sessions = useMemo(
    () =>
      [...held.values()]
        .filter((session) => session.archivedAt === null)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_LISTED),
    [held],
  );

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { sessionId } = await runtime.rpc.call("sessions.create", { cwd: cwd.trim() });
      await navigate({ to: "/s/$sessionId", params: { sessionId } });
    } catch (failure) {
      // The session may have been made though no answer came (R105): the stream shows it if it was.
      setError(failureText(failure));
    }
    setBusy(false);
  };

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 overflow-y-auto p-4">
      <h1 className="text-xl font-extrabold text-fg">{t("sessions.title")}</h1>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <TextField
          label={t("sessions.cwd")}
          hint={t("sessions.cwdHint")}
          value={cwd}
          onChange={setCwd}
          error={error}
          name="cwd"
        />
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
        <div className="flex items-center gap-2">
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
        <ul className="flex flex-col gap-1">
          {sessions.map((session) => (
            <li key={session.id} className="flex items-center gap-2">
              <div className="flex min-w-0 flex-col">
                <Link
                  to="/s/$sessionId"
                  params={{ sessionId: session.id }}
                  className={cn("break-all text-agent underline", FOCUS_RING)}
                >
                  {session.name ?? session.cwd}
                </Link>
                {session.name ? <span className="break-all text-ui text-muted">{session.cwd}</span> : null}
              </div>
              <span className="font-mono text-label font-semibold uppercase tracking-label text-muted">
                {t(`session.status.${session.status}`)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

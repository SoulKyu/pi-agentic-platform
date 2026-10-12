import type { SessionSummary } from "@pap/contracts";
import { Button, cn, FOCUS_RING, TextField } from "@pap/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { t } from "../../i18n/index.ts";
import { getRuntime, useConnectionState } from "../../runtime/index.ts";
import { failureCode, failureText, outcomeUnknown } from "./failure.ts";

// A dropped connection has its own banner and the next connection lists again: only a real refusal is shown.
const isConnectionLoss = (code: string): boolean => code === "offline" || code === "connection_lost";

export function SessionListScreen() {
  const runtime = getRuntime();
  const connection = useConnectionState(runtime.connection);
  const navigate = useNavigate();
  const [cwd, setCwd] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped to list again without a new connection.
  const [listings, setListings] = useState(0);

  useEffect(() => {
    if (connection !== "open") return;
    let current = true;
    runtime.rpc.call("sessions.list", {}).then(
      (result) => {
        if (!current) return;
        setListError(null);
        setSessions([...result.sessions].sort((a, b) => b.updatedAt - a.updatedAt));
      },
      (failure: unknown) => {
        if (current) setListError(isConnectionLoss(failureCode(failure)) ? null : failureText(failure));
      },
    );
    return () => {
      current = false;
    };
  }, [connection, runtime, listings]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { sessionId } = await runtime.rpc.call("sessions.create", { cwd: cwd.trim() });
      await navigate({ to: "/s/$sessionId", params: { sessionId } });
    } catch (failure) {
      setError(failureText(failure));
      // The session may have been made though no answer came (R105): the list tells.
      if (outcomeUnknown(failure)) setListings((count) => count + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 overflow-y-auto p-4">
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
      {listError ? (
        <p role="alert" className="text-ui text-attention">
          {listError}
        </p>
      ) : null}
      {sessions.length === 0 ? (
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
    </main>
  );
}

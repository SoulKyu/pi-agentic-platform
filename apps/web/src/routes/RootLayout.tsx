import { Button, InlineError, LoadingLine } from "@pap/ui";
import { useEffect, useMemo } from "react";
import { LoginScreen } from "../features/auth/LoginScreen.tsx";
import { useAuthGate } from "../features/auth/use-auth-gate.ts";
import { errorKey, t } from "../i18n/index.ts";
import { getRuntime, useConnectionState } from "../runtime/index.ts";
import { parseWindowPath } from "../features/previews/previews.vm.ts";
import { LazyInvite } from "./invite/LazyInvite.tsx";
import { LazyPreviewWindow } from "./preview/LazyPreviewWindow.tsx";
import { LazyFirstRun } from "./setup/LazyFirstRun.tsx";
import { AppShell } from "./shell/AppShell.tsx";

export function RootLayout() {
  const { state, refresh, retry } = useAuthGate();
  const runtime = getRuntime();
  const connection = useConnectionState(runtime.connection);
  // `/preview/<box>/<name>` is a window of its own (UX2-R79): read once, the path never changes inside it.
  const previewWindow = useMemo(() => parseWindowPath(window.location.pathname), []);

  useEffect(() => {
    if (state.phase === "ready") runtime.connection.start();
    else runtime.connection.stop();
  }, [state.phase, runtime]);
  useEffect(() => {
    if (connection === "signed-out") refresh();
  }, [connection, refresh]);

  if (state.phase === "loading")
    return (
      <main className="p-s5">
        <LoadingLine label={t("app.loading")} />
      </main>
    );
  if (state.phase === "error") {
    return (
      <main className="flex flex-col items-start gap-s3 p-s5">
        <InlineError announce="background">
          {t(state.code === null ? "error.offline" : errorKey(state.code))}
        </InlineError>
        <Button onClick={retry}>{t("gate.retry")}</Button>
      </main>
    );
  }
  // The account step signs the owner in: from then on the stepper needs the socket (steps 2 and 3 call the server).
  if (state.phase === "setup")
    return <LazyFirstRun onDone={refresh} onAccountCreated={() => runtime.connection.start()} />;
  if (state.phase === "invite")
    return <LazyInvite token={state.token} signedInAs={state.signedInAs} onDone={refresh} />;
  if (state.phase === "login")
    return <LoginScreen passkeysAvailable={state.passkeysAvailable} onDone={refresh} />;
  if (previewWindow !== null) return <LazyPreviewWindow box={previewWindow.box} name={previewWindow.name} />;
  return (
    <AppShell
      username={state.username}
      role={state.role}
      passkeysAvailable={state.passkeysAvailable}
      onSignedOut={refresh}
    />
  );
}

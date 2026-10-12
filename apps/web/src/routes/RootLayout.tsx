import { Button } from "@pap/ui";
import { useEffect } from "react";
import { LoginScreen } from "../features/auth/LoginScreen.tsx";
import { SetupScreen } from "../features/auth/SetupScreen.tsx";
import { useAuthGate } from "../features/auth/use-auth-gate.ts";
import { errorKey, t } from "../i18n/index.ts";
import { getRuntime, useConnectionState } from "../runtime/index.ts";
import { AppShell } from "./shell/AppShell.tsx";

export function RootLayout() {
  const { state, refresh, retry } = useAuthGate();
  const runtime = getRuntime();
  const connection = useConnectionState(runtime.connection);

  useEffect(() => {
    if (state.phase === "ready") runtime.connection.start();
    else runtime.connection.stop();
  }, [state.phase, runtime]);
  useEffect(() => {
    if (connection === "signed-out") refresh();
  }, [connection, refresh]);

  if (state.phase === "loading") return <main className="p-6 text-muted">{t("app.loading")}</main>;
  if (state.phase === "error") {
    return (
      <main className="flex flex-col items-start gap-3 p-6">
        <p role="alert" className="text-err">
          {t(state.code === null ? "error.offline" : errorKey(state.code))}
        </p>
        <Button onClick={retry}>{t("gate.retry")}</Button>
      </main>
    );
  }
  if (state.phase === "setup") return <SetupScreen onDone={refresh} />;
  if (state.phase === "login")
    return <LoginScreen passkeysAvailable={state.passkeysAvailable} onDone={refresh} />;
  return (
    <AppShell username={state.username} passkeysAvailable={state.passkeysAvailable} onSignedOut={refresh} />
  );
}

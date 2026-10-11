import { Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { AccountBar } from "../features/auth/AccountBar.tsx";
import { LoginScreen } from "../features/auth/LoginScreen.tsx";
import { SetupScreen } from "../features/auth/SetupScreen.tsx";
import { useAuthGate } from "../features/auth/use-auth-gate.ts";
import { t } from "../i18n/index.ts";
import { getRuntime, useConnectionState } from "../runtime/index.ts";

export function RootLayout() {
  const { state, refresh } = useAuthGate();
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
      <main role="alert" className="p-6 text-attention">
        {t("error.offline")}
      </main>
    );
  }
  if (state.phase === "setup") return <SetupScreen onDone={refresh} />;
  if (state.phase === "login")
    return <LoginScreen passkeysAvailable={state.passkeysAvailable} onDone={refresh} />;
  return (
    <div className="flex h-full flex-col">
      <AccountBar
        username={state.username}
        passkeysAvailable={state.passkeysAvailable}
        onSignedOut={refresh}
      />
      {connection === "outdated" ? (
        <p role="alert" className="px-4 py-2 text-ui text-attention">
          {t("connection.outdated")}
        </p>
      ) : null}
      {connection === "waiting" ? (
        <p role="status" className="px-4 py-2 text-ui text-muted">
          {t("connection.reconnecting")}
        </p>
      ) : null}
      <Outlet />
    </div>
  );
}

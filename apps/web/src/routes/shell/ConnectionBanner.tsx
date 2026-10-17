import { Banner, Button } from "@pap/ui";
import { useEffect, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime, useConnectionState, windowTimers } from "../../runtime/index.ts";
import type { Connection } from "../../runtime/connection.ts";

/** The clock in ms, refreshed each second while `active`: only the component that calls it re-renders for the countdown. */
function useSecondClock(active: boolean): number {
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    let id = 0;
    const arm = () => {
      id = windowTimers.set(() => {
        setNowMs(Date.now());
        arm();
      }, 1_000);
    };
    arm();
    return () => windowTimers.clear(id);
  }, [active]);
  return nowMs;
}

function LostBanner({ connection, waiting }: { connection: Connection; waiting: boolean }) {
  const t = useT();
  const nowMs = useSecondClock(waiting);
  const { retryAt } = connection;
  const armed = waiting && retryAt !== null;
  // The live region announces one stable line; the changing seconds are hidden from it (no announcement per second).
  return (
    <Banner
      tone="offline"
      title={waiting ? t("connection.silent") : t("connection.reconnecting")}
      actions={
        // Disabled while the probe runs (up to its deadline): retry() has nothing to act on until a retry is armed.
        <Button disabled={!armed} onClick={() => connection.retry()}>
          {t("connection.retry")}
        </Button>
      }
    >
      {armed ? (
        <span aria-hidden="true" className="block">
          {t("connection.retryIn", { seconds: Math.max(0, Math.ceil((retryAt - nowMs) / 1_000)) })}
        </span>
      ) : null}
      {t("connection.draftsStay")}
    </Banner>
  );
}

export function ConnectionBanner() {
  const t = useT();
  const { connection } = getRuntime();
  const state = useConnectionState(connection);
  // A socket that opens again after a loss is still "the daemon came back", not a first connection.
  const [lost, setLost] = useState(false);
  if (state === "waiting" && !lost) setLost(true);
  else if ((state === "open" || state === "idle") && lost) setLost(false);
  if ((state === "waiting" || state === "connecting") && lost) {
    return <LostBanner key={state} connection={connection} waiting={state === "waiting"} />;
  }
  if (state === "outdated") {
    return (
      <Banner
        tone="capacity"
        title={t("connection.outdated")}
        actions={<Button onClick={() => window.location.reload()}>{t("shell.reload")}</Button>}
      />
    );
  }
  return null;
}

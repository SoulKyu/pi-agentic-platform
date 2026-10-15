import { AutomationSettings } from "@pap/contracts";
import { useEffect, useRef } from "react";
import { getRuntime, useConnectionState } from "../runtime/index.ts";

/**
 * Reads the stored `paused` flag again when the stream comes back (`open` after another state) and when the page becomes
 * visible, so a tab that slept does not keep a pause another tab has since changed. A read that fails changes nothing:
 * the stream still says what it says.
 */
export function usePauseReread(apply: (paused: boolean) => void): void {
  const state = useConnectionState(getRuntime().connection);
  const latest = useRef(apply);
  useEffect(() => {
    latest.current = apply;
  });
  const before = useRef(state);

  useEffect(() => {
    let live = true;
    const reread = () => {
      getRuntime()
        .rpc.call("settings.get", { key: "automation" })
        .then(
          (answer) => {
            const parsed = AutomationSettings.safeParse(answer.value ?? {});
            if (live && parsed.success) latest.current(parsed.data.paused);
          },
          () => undefined,
        );
    };
    if (state === "open" && before.current !== "open") reread();
    before.current = state;
    const onVisible = () => {
      if (document.visibilityState === "visible") reread();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [state]);
}

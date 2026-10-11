import { useCallback, useEffect, useState } from "react";
import { fetchAuthStatus } from "./auth-api.ts";
import { passkeysUsable } from "./passkey-support.ts";

export type GateState =
  | { readonly phase: "loading" }
  | { readonly phase: "error" }
  | { readonly phase: "setup" }
  | { readonly phase: "login"; readonly passkeysAvailable: boolean }
  | { readonly phase: "ready"; readonly username: string | null; readonly passkeysAvailable: boolean };

export function useAuthGate(): { state: GateState; refresh(): void; retry(): void } {
  const [state, setState] = useState<GateState>({ phase: "loading" });
  const refresh = useCallback(() => {
    fetchAuthStatus().then(
      (status) =>
        setState(
          status.setupRequired
            ? { phase: "setup" }
            : status.authenticated
              ? {
                  phase: "ready",
                  username: status.username,
                  passkeysAvailable: passkeysUsable(status.passkeysAvailable),
                }
              : { phase: "login", passkeysAvailable: passkeysUsable(status.passkeysAvailable) },
        ),
      () => setState({ phase: "error" }),
    );
  }, []);
  useEffect(refresh, [refresh]);
  const retry = useCallback(() => {
    setState({ phase: "loading" });
    refresh();
  }, [refresh]);
  // A server that could not be reached is asked again as soon as the browser says the network is back.
  useEffect(() => {
    if (state.phase !== "error") return;
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [state.phase, retry]);
  return { state, refresh, retry };
}

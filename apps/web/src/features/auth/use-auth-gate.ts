import { useCallback, useEffect, useState } from "react";
import { fetchAuthStatus } from "./auth-api.ts";

export type GateState =
  | { readonly phase: "loading" }
  | { readonly phase: "error" }
  | { readonly phase: "setup" }
  | { readonly phase: "login"; readonly passkeysAvailable: boolean }
  | { readonly phase: "ready"; readonly username: string | null; readonly passkeysAvailable: boolean };

export function useAuthGate(): { state: GateState; refresh(): void } {
  const [state, setState] = useState<GateState>({ phase: "loading" });
  const refresh = useCallback(() => {
    fetchAuthStatus().then(
      (status) =>
        setState(
          status.setupRequired
            ? { phase: "setup" }
            : status.authenticated
              ? { phase: "ready", username: status.username, passkeysAvailable: status.passkeysAvailable }
              : { phase: "login", passkeysAvailable: status.passkeysAvailable },
        ),
      () => setState({ phase: "error" }),
    );
  }, []);
  useEffect(refresh, [refresh]);
  return { state, refresh };
}

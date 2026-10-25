import type { Role } from "@pap/contracts";
import { useCallback, useEffect, useState } from "react";
import { fetchAuthStatus } from "./auth-api.ts";
import { passkeysUsable } from "./passkey-support.ts";

export type GateState =
  | { readonly phase: "loading" }
  /** `code`: why, when the server said (`read_only`); null for a server that could not be reached. */
  | { readonly phase: "error"; readonly code: string | null }
  | { readonly phase: "setup" }
  /** An invitation address (`/invite#token=...`). `token` null: the address carried none. `signedInAs`: another open session. */
  | { readonly phase: "invite"; readonly token: string | null; readonly signedInAs: string | null }
  | { readonly phase: "login"; readonly passkeysAvailable: boolean }
  | {
      readonly phase: "ready";
      readonly username: string | null;
      /** UX only: the daemon refuses a member whatever the page shows. An unknown role shows the least. */
      readonly role: Role;
      readonly passkeysAvailable: boolean;
    };

const INVITE_PATH = "/invite";

// StrictMode runs effects twice and the hash is gone after the first read: the token is kept while the invitation is open.
let heldToken: string | null | undefined;

/** Drops the held token: the invitation is accepted, refused for good, or left. */
export function forgetInviteToken(): void {
  heldToken = undefined;
}

/**
 * The invitation token of the hash, in memory only: the hash is cleared at once, so it stays in no address bar or
 * history. A new `#token=` (a second link in the same tab) replaces the held one.
 */
function takeInviteToken(): string | null {
  if (window.location.pathname !== INVITE_PATH) return null;
  const hash = window.location.hash;
  if (hash === "") return heldToken ?? null;
  heldToken = new URLSearchParams(hash.slice(1)).get("token") || null;
  window.history.replaceState(null, "", INVITE_PATH);
  return heldToken;
}

export function useAuthGate(): { state: GateState; refresh(): void; retry(): void } {
  const [state, setState] = useState<GateState>({ phase: "loading" });
  const refresh = useCallback(() => {
    const inviteToken = takeInviteToken();
    fetchAuthStatus().then(
      (status) =>
        setState(
          status.setupRequired
            ? { phase: "setup" }
            : window.location.pathname === INVITE_PATH
              ? {
                  phase: "invite",
                  token: inviteToken,
                  signedInAs: status.authenticated ? status.username : null,
                }
              : status.authenticated
                ? {
                    phase: "ready",
                    username: status.username,
                    role: status.role ?? "member",
                    passkeysAvailable: passkeysUsable(status.passkeysAvailable),
                  }
                : { phase: "login", passkeysAvailable: passkeysUsable(status.passkeysAvailable) },
        ),
      (error: unknown) => {
        const code = (error as { code?: unknown } | null)?.code;
        setState({ phase: "error", code: typeof code === "string" ? code : null });
      },
    );
  }, []);
  useEffect(refresh, [refresh]);
  // A second invitation link opened in this tab is read again; leaving the invitation address forgets the token.
  useEffect(() => {
    const onNavigate = () => {
      if (window.location.pathname !== INVITE_PATH) forgetInviteToken();
      else if (window.location.hash !== "") refresh();
    };
    window.addEventListener("hashchange", onNavigate);
    window.addEventListener("popstate", onNavigate);
    return () => {
      window.removeEventListener("hashchange", onNavigate);
      window.removeEventListener("popstate", onNavigate);
    };
  }, [refresh]);
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

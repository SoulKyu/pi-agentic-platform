import { Button, InlineError, TextField, LoadingLine } from "@pap/ui";
import { INVITE_USERNAME } from "@pap/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorKey, useT } from "../../i18n/index.ts";
import { acceptInvite, inviteInfo } from "./auth-api.ts";
import { AuthFrame } from "./AuthFrame.tsx";
import { authErrorText } from "./auth-error.ts";
import { forgetInviteToken } from "./use-auth-gate.ts";
import { PasskeyStep } from "./PasskeyStep.tsx";
import "./register-invite.ts";

type Phase =
  | { readonly kind: "loading" }
  | { readonly kind: "refused"; readonly error: string }
  /** The server could not answer (busy, offline): the invitation may be fine, the token is still held. */
  | { readonly kind: "retry"; readonly error: string; readonly seconds: number }
  | { readonly kind: "confirm"; readonly inviter: string }
  | { readonly kind: "form"; readonly inviter: string }
  | { readonly kind: "passkey" };

/**
 * An invitation (M14): who invites, the setup's two fields, then the setup's passkey step. The token lives in this
 * component's memory only: it came from the hash, which the gate already cleared, and it never reaches a log or a message.
 */
export function InviteScreen({
  token,
  signedInAs,
  onDone,
}: {
  /** Null when the address carried none. */
  readonly token: string | null;
  /** Someone else's open session: accepting signs them out. */
  readonly signedInAs: string | null;
  /** The page is over: the host leaves the invitation address and reads the status again. */
  onDone(): void;
}) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>(
    token === null
      ? {
          kind: "refused",
          error: authErrorText({ ok: false, code: "invite_invalid", retryAfterSeconds: null }),
        }
      : { kind: "loading" },
  );
  const [waiting, setWaiting] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const alive = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const check = useCallback(() => {
    if (token === null) return;
    void inviteInfo(token).then((result) => {
      if (!alive.current) return;
      if (result.ok) setPhase({ kind: signedInAs === null ? "form" : "confirm", inviter: result.inviter });
      else if (result.code === "invite_invalid") {
        forgetInviteToken();
        setPhase({ kind: "refused", error: authErrorText(result) });
      } else {
        setPhase({ kind: "retry", error: authErrorText(result), seconds: result.retryAfterSeconds ?? 0 });
        if (result.retryAfterSeconds) {
          setWaiting(true);
          timer.current = setTimeout(() => setWaiting(false), result.retryAfterSeconds * 1000);
        }
      }
    });
  }, [token, signedInAs]);
  useEffect(() => {
    alive.current = true;
    check();
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, [check]);
  const retry = () => {
    clearTimeout(timer.current);
    setWaiting(false);
    setPhase({ kind: "loading" });
    check();
  };

  const finish = () => {
    forgetInviteToken();
    window.history.replaceState(null, "", "/");
    onDone();
  };
  const submit = async () => {
    if (token === null) return;
    setBusy(true);
    setError(null);
    setUsernameError(null);
    const result = await acceptInvite(token, username, password);
    setBusy(false);
    if (result.ok) {
      forgetInviteToken();
      setPassword("");
      setPhase({ kind: "passkey" });
    } else if (result.code === "username_taken") setUsernameError(t(errorKey("username_taken")));
    else if (result.code === "invite_invalid") {
      forgetInviteToken();
      setPhase({ kind: "refused", error: authErrorText(result) });
    } else setError(authErrorText(result));
  };

  if (phase.kind === "passkey") return <PasskeyStep steps={null} onNext={finish} onSignedOut={finish} />;
  if (phase.kind === "loading")
    return (
      <AuthFrame title={t("invite.title")}>
        <LoadingLine label={t("invite.loading")} />
      </AuthFrame>
    );
  if (phase.kind === "retry")
    return (
      <AuthFrame title={t("invite.title")}>
        <InlineError announce="action">{phase.error}</InlineError>
        <p className="text-ui text-muted">{t("invite.retryHint")}</p>
        <div>
          <Button variant="primary" disabled={waiting} onClick={retry}>
            {t("invite.retry")}
          </Button>
        </div>
      </AuthFrame>
    );
  if (phase.kind === "refused")
    return (
      <AuthFrame title={t("invite.title")}>
        <InlineError announce="action">{phase.error}</InlineError>
      </AuthFrame>
    );
  const invited = <p className="text-ui text-fg">{t("invite.inviter", { inviter: phase.inviter })}</p>;
  if (phase.kind === "confirm")
    return (
      <AuthFrame title={t("invite.title")}>
        {invited}
        <p role="status" className="text-ui text-attn">
          {t("invite.signedIn", { name: signedInAs ?? "" })}
        </p>
        <div className="flex gap-s2">
          <Button variant="primary" onClick={() => setPhase({ kind: "form", inviter: phase.inviter })}>
            {t("invite.continue")}
          </Button>
          <Button onClick={finish}>{t("invite.back")}</Button>
        </div>
      </AuthFrame>
    );
  return (
    <AuthFrame title={t("invite.title")}>
      {invited}
      <form
        className="flex flex-col gap-s3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextField
          label={t("setup.username")}
          value={username}
          onChange={(value) => {
            setUsername(value);
            setUsernameError(null);
          }}
          name="username"
          autoComplete="username"
          hint={t("setup.usernameHint")}
          error={usernameError}
        />
        <TextField
          label={t("setup.password")}
          value={password}
          onChange={setPassword}
          type="password"
          name="password"
          autoComplete="new-password"
          hint={t("setup.passwordHint")}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={busy || password.length < 12 || !INVITE_USERNAME.test(username)}
        >
          {t("invite.submit")}
        </Button>
      </form>
      {error ? <InlineError announce="action">{error}</InlineError> : null}
    </AuthFrame>
  );
}

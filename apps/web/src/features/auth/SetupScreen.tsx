import { Button, InlineError, TextField } from "@pap/ui";
import { useState, type ReactNode } from "react";
import { useT } from "../../i18n/index.ts";
import { setupOwner } from "./auth-api.ts";
import { AuthFrame } from "./AuthFrame.tsx";
import { authErrorText } from "./auth-error.ts";

// What the server accepts as a username (apps/daemon, auth/http.ts): a name it would refuse is not sent.
const USERNAME = /^[A-Za-z0-9_.-]{1,64}$/;

export function SetupScreen({ onDone, steps }: { onDone(): void; steps?: ReactNode }) {
  const t = useT();
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(token ? null : t("setup.missingToken"));
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await setupOwner(token, username, password);
    setBusy(false);
    if (!result.ok) {
      // The token is the only credential here: a refusal means it is wrong or already used.
      setError(authErrorText(result, "setup.missingToken"));
      return;
    }
    // The address carried the one-time token: drop it from the history entry too.
    window.history.replaceState(null, "", "/");
    onDone();
  };
  return (
    <AuthFrame title={t("setup.title")} above={steps}>
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
          onChange={setUsername}
          name="username"
          autoComplete="username"
          hint={t("setup.usernameHint")}
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
          disabled={busy || !token || password.length < 12 || !USERNAME.test(username)}
        >
          {t("setup.submit")}
        </Button>
      </form>
      {error ? <InlineError announce="action">{error}</InlineError> : null}
    </AuthFrame>
  );
}

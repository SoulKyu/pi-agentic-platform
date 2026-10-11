import { Button, TextField } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { login, loginWithPasskey, type AuthResult } from "./auth-api.ts";
import { AuthFrame } from "./AuthFrame.tsx";
import { authErrorText } from "./auth-error.ts";

export function LoginScreen({ passkeysAvailable, onDone }: { passkeysAvailable: boolean; onDone(): void }) {
  const t = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attempt = (run: Promise<AuthResult>) => {
    setBusy(true);
    setError(null);
    void run.then((result) => {
      setBusy(false);
      if (result.ok) onDone();
      else setError(authErrorText(result, "login.failed"));
    });
  };
  return (
    <AuthFrame title={t("login.title")}>
      {passkeysAvailable ? (
        <div>
          <Button variant="primary" disabled={busy} onClick={() => attempt(loginWithPasskey())}>
            {t("login.passkey")}
          </Button>
        </div>
      ) : null}
      <form
        className="flex flex-col gap-s3"
        onSubmit={(event) => {
          event.preventDefault();
          attempt(login(username, password));
        }}
      >
        <TextField
          label={t("setup.username")}
          value={username}
          onChange={setUsername}
          name="username"
          autoComplete="username webauthn"
        />
        <TextField
          label={t("setup.password")}
          value={password}
          onChange={setPassword}
          type="password"
          name="password"
          autoComplete="current-password"
        />
        <Button
          type="submit"
          variant={passkeysAvailable ? "secondary" : "primary"}
          disabled={busy || username === "" || password === ""}
        >
          {t("login.submit")}
        </Button>
      </form>
      <p className="text-ui text-muted">{t("login.throttleNote")}</p>
      {error ? (
        <p role="alert" className="text-ui text-attention">
          {error}
        </p>
      ) : null}
    </AuthFrame>
  );
}

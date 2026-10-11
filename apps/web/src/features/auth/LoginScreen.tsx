import { Button, TextField } from "@pap/ui";
import { useState } from "react";
import { t } from "../../i18n/index.ts";
import { login, loginWithPasskey, type AuthResult } from "./auth-api.ts";
import { authErrorText } from "./auth-error.ts";

export function LoginScreen({ passkeysAvailable, onDone }: { passkeysAvailable: boolean; onDone(): void }) {
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
    <main className="mx-auto flex w-full max-w-sm flex-col gap-4 p-6">
      <h1 className="text-xl font-extrabold text-fg">{t("login.title")}</h1>
      {passkeysAvailable ? (
        <div>
          <Button variant="primary" disabled={busy} onClick={() => attempt(loginWithPasskey())}>
            {t("login.passkey")}
          </Button>
        </div>
      ) : null}
      <form
        className="flex flex-col gap-3"
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
      {error ? (
        <p role="alert" className="text-ui text-attention">
          {error}
        </p>
      ) : null}
    </main>
  );
}

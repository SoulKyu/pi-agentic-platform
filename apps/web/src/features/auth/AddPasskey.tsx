import { Button, TextField } from "@pap/ui";
import { useState } from "react";
import { t } from "../../i18n/index.ts";
import { registerPasskey } from "./auth-api.ts";
import { authErrorText } from "./auth-error.ts";

interface AddPasskeyProps {
  onAdded(): void;
  /** The server no longer knows this session: the password was not the problem. */
  onSignedOut(): void;
}

/** One button; it opens a password field, because the server only adds a passkey for someone who knows it. */
export function AddPasskey({ onAdded, onSignedOut }: AddPasskeyProps) {
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setAsking(false);
    setPassword("");
    setError(null);
  };
  const submit = () => {
    setBusy(true);
    setError(null);
    void registerPasskey(password).then((result) => {
      setBusy(false);
      if (result.ok) {
        close();
        onAdded();
      } else if (result.code === "unauthenticated") onSignedOut();
      else setError(authErrorText(result));
    });
  };

  if (!asking) return <Button onClick={() => setAsking(true)}>{t("account.addPasskey")}</Button>;
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextField
        label={t("setup.password")}
        hint={t("account.passkeyPasswordHint")}
        value={password}
        onChange={setPassword}
        type="password"
        name="password"
        autoComplete="current-password"
        error={error}
        disabled={busy}
      />
      <Button type="submit" variant="primary" disabled={busy || password === ""}>
        {t("account.addPasskey")}
      </Button>
      <Button disabled={busy} onClick={close}>
        {t("account.cancel")}
      </Button>
    </form>
  );
}

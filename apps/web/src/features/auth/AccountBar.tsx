import { Button } from "@pap/ui";
import { useState } from "react";
import { t } from "../../i18n/index.ts";
import { AddPasskey } from "./AddPasskey.tsx";
import { logout } from "./auth-api.ts";

interface AccountBarProps {
  username: string | null;
  passkeysAvailable: boolean;
  onSignedOut(): void;
}

export function AccountBar({ username, passkeysAvailable, onSignedOut }: AccountBarProps) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
      <span className="font-mono text-label font-semibold uppercase tracking-label text-muted">
        {t("app.name")} · {username}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <span role="status" className="text-ui text-muted">
          {message}
        </span>
        {passkeysAvailable ? (
          <AddPasskey onAdded={() => setMessage(t("account.passkeyAdded"))} onSignedOut={onSignedOut} />
        ) : null}
        <Button onClick={() => void logout().then(onSignedOut)}>{t("account.logout")}</Button>
      </div>
    </header>
  );
}

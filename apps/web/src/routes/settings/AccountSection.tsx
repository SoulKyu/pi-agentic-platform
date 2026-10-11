import { Button } from "@pap/ui";
import { useState } from "react";
import { AddPasskey } from "../../features/auth/AddPasskey.tsx";
import { useT } from "../../i18n/index.ts";
import { signOut } from "../shell/sign-out.ts";
import { useShell } from "../shell/shell-context.ts";

/** Username, passkeys and sign-out. Connected devices arrive with M5 (M3R107). */
export function AccountSection() {
  const t = useT();
  const { username, passkeysAvailable, onSignedOut } = useShell();
  const [added, setAdded] = useState(false);
  return (
    <div className="flex flex-col items-start gap-s4">
      {username ? (
        <p className="text-ui text-muted">
          {t("settings.account.username")} <span className="font-mono text-fg">{username}</span>
        </p>
      ) : null}
      {passkeysAvailable ? (
        <div className="flex flex-col items-start gap-s2">
          <AddPasskey onAdded={() => setAdded(true)} onSignedOut={onSignedOut} />
          {added ? (
            <p role="status" className="text-ui text-muted">
              {t("account.passkeyAdded")}
            </p>
          ) : null}
        </div>
      ) : null}
      <Button variant="secondary" onClick={() => signOut(onSignedOut)}>
        {t("settings.account.signOut")}
      </Button>
    </div>
  );
}

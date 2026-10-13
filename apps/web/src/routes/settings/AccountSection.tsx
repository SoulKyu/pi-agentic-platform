import { Button } from "@pap/ui";
import { DevicesList } from "../../features/auth/DevicesList.tsx";
import { PasskeysList } from "../../features/auth/PasskeysList.tsx";
import { useT } from "../../i18n/index.ts";
import { signOut } from "../shell/sign-out.ts";
import { useShell } from "../shell/shell-context.ts";

/** Username, connected devices, passkeys and sign-out. API tokens join with M5 Task 23. */
export function AccountSection() {
  const t = useT();
  const { username, passkeysAvailable, onSignedOut } = useShell();
  return (
    <div className="flex flex-col items-start gap-s5">
      {username ? (
        <p className="text-ui text-muted">
          {t("settings.account.username")} <span className="font-mono text-fg">{username}</span>
        </p>
      ) : null}
      <DevicesList signOutHere={() => signOut(onSignedOut)} />
      <PasskeysList passkeysAvailable={passkeysAvailable} onSignedOut={onSignedOut} />
      <Button variant="secondary" onClick={() => signOut(onSignedOut)}>
        {t("settings.account.signOut")}
      </Button>
    </div>
  );
}

import { sourceUrl } from "@pap/contracts";
import { Button } from "@pap/ui";
import { DevicesList } from "../../features/auth/DevicesList.tsx";
import { PasskeysList } from "../../features/auth/PasskeysList.tsx";
import { TokensPanel } from "../../features/auth/TokensPanel.tsx";
import { useT } from "../../i18n/index.ts";
import { getRuntime, useConnectionState } from "../../runtime/index.ts";
import { signOut } from "../shell/sign-out.ts";
import { useShell } from "../shell/shell-context.ts";

/** Username, connected devices, passkeys, API tokens, sign-out and the Source code link (AGPL section 13). */
export function AccountSection() {
  const t = useT();
  const { username, passkeysAvailable, onSignedOut } = useShell();
  const { connection } = getRuntime();
  useConnectionState(connection); // the hello frame sets the version: render again once it is known
  return (
    <div className="flex flex-col items-start gap-s5">
      {username ? (
        <p className="text-ui text-muted">
          {t("settings.account.username")} <span className="font-mono text-fg">{username}</span>
        </p>
      ) : null}
      <DevicesList signOutHere={() => signOut(onSignedOut)} />
      <PasskeysList passkeysAvailable={passkeysAvailable} onSignedOut={onSignedOut} />
      <TokensPanel onSignedOut={onSignedOut} />
      <Button variant="secondary" onClick={() => signOut(onSignedOut)}>
        {t("settings.account.signOut")}
      </Button>
      <p className="text-ui text-muted">
        {t("settings.source.lead")}{" "}
        <a
          href={sourceUrl(connection.serverVersion)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-fg underline focus-ring"
        >
          {t("settings.source.link")}
        </a>
      </p>
    </div>
  );
}

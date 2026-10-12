import { toast } from "@pap/ui";
import { logout } from "../../features/auth/auth-api.ts";
import { t } from "../../i18n/index.ts";

/** The one sign-out: the rail's menu and the `auth.signOut` command both run it. */
export function signOut(onSignedOut: () => void): void {
  void logout().then(onSignedOut, () => toast({ message: t("shell.signOutFailed"), tone: "error" }));
}

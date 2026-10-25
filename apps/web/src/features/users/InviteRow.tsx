import type { InviteView } from "@pap/contracts";
import { Button, Chip } from "@pap/ui";
import { useLocale, useT } from "../../i18n/index.ts";
import { whenText } from "./format.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useUserAction } from "./use-users.ts";

/** A pending invitation: `att` while it waits for the person it was sent to, REVOKE ends it. */
export function InviteRow({ invite, onRevoked }: { readonly invite: InviteView; onRevoked(): void }) {
  const t = useT();
  const locale = useLocale();
  const action = useUserAction();
  const hint = invite.nameHint ?? "—";
  const revoke = () =>
    action.run(async () => {
      await getRuntime().rpc.call("users.revokeInvite", { inviteId: invite.id });
      onRevoked();
    });
  return (
    <li data-invite={invite.id} className="flex flex-col gap-s1 border-b border-border py-s2">
      <div className="flex flex-wrap items-center gap-s2">
        <span className="text-ui text-fg">
          {t("users.invite.pending", { hint, time: whenText(invite.expiresAt, locale) })}
        </span>
        <Chip tone="att" label={t("users.invite.pendingChip")} />
        <span className="flex-1" />
        <Button
          variant="secondary"
          pendingSince={action.since}
          aria-label={t("users.invite.revokeOne", { hint })}
          onClick={revoke}
        >
          {t("users.invite.revoke")}
        </Button>
      </div>
      {action.problem === null ? null : (
        <p role="status" className="text-ui text-err">
          {t(action.problem)}
        </p>
      )}
    </li>
  );
}

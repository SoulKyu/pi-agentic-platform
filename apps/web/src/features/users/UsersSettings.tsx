import { Button, InlineError } from "@pap/ui";
import { WaitLine } from "../../lib/wait-since.tsx";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import type { StepUpRunner } from "../../lib/step-up-context.tsx";
import { InviteDialog } from "./InviteDialog.tsx";
import { InviteRow } from "./InviteRow.tsx";
import { ProvidersSharing } from "./ProvidersSharing.tsx";
import { UserRow } from "./UserRow.tsx";
import { useUsers } from "./use-users.ts";

interface Props {
  /** The password prompt of the Settings host: `null` means the person cancelled it. */
  readonly stepUp: StepUpRunner;
}

/** Settings › Users (owner only): pending invitations, the members with their budgets, then the providers shared with their boxes. */
export function UsersSettings({ stepUp }: Props) {
  const t = useT();
  const { state, reload, retry } = useUsers();
  const [inviting, setInviting] = useState(false);

  if (state.kind === "loading") return <WaitLine label={t("users.loading")} />;
  if (state.kind === "failed")
    return (
      <div className="flex flex-col items-start gap-s2">
        <InlineError announce="background">{t("users.failed")}</InlineError>
        <Button onClick={retry}>{t("users.retry")}</Button>
      </div>
    );

  return (
    <div className="flex flex-col gap-s5">
      <p className="text-ui text-muted">{t("users.intro")}</p>
      <section className="flex flex-col gap-s2">
        <div className="flex flex-wrap items-center gap-s2">
          <h2 className="flex-1 text-ui font-semibold text-fg">{t("users.title")}</h2>
          <Button variant="primary" onClick={() => setInviting(true)}>
            {t("users.invite")}
          </Button>
        </div>
        {state.invites.length === 0 ? null : (
          <ul className="flex flex-col">
            {state.invites.map((invite) => (
              <InviteRow key={invite.id} invite={invite} onRevoked={reload} />
            ))}
          </ul>
        )}
        <ul className="flex flex-col">
          {state.users.map((user) => (
            <UserRow key={user.id} user={user} stepUp={stepUp} onChanged={reload} />
          ))}
        </ul>
      </section>
      <ProvidersSharing providers={state.providers} onChanged={reload} />
      {inviting ? (
        <InviteDialog
          stepUp={stepUp}
          onClose={() => {
            setInviting(false);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

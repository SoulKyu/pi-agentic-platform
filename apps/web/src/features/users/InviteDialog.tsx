import { USERS_LIMITS } from "@pap/contracts";
import { Button, TextField } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useId, useRef, useState } from "react";
import { useLocale, useT } from "../../i18n/index.ts";
import type { StepUpRunner } from "../../lib/step-up-context.tsx";
import { getRuntime } from "../../runtime/index.ts";
import { whenText } from "./format.ts";
import { useUserAction } from "./use-users.ts";

interface Props {
  readonly stepUp: StepUpRunner;
  onClose(): void;
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Invite a member: the hint, the step-up, then the link once. The link lives only in this component's state; closing the
 * dialog unmounts it. It is never put in storage, a store or a log.
 */
export function InviteDialog({ stepUp, onClose }: Props) {
  const t = useT();
  const locale = useLocale();
  const linkId = useId();
  const action = useUserAction();
  const [hint, setHint] = useState("");
  const [issued, setIssued] = useState<{ readonly url: string; readonly expiresAt: number } | null>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const input = useRef<HTMLInputElement>(null);

  const invite = () =>
    action.run(async () => {
      const name = hint.trim();
      const done = await stepUp((commandId) =>
        getRuntime().rpc.call("users.invite", name === "" ? {} : { nameHint: name }, { commandId }),
      );
      if (done === null) return;
      setIssued({ url: done.url, expiresAt: done.expiresAt });
      queueMicrotask(() => input.current?.select());
    });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("users.invite.title")}
      closeLabel={t("ui.close")}
      footer={
        issued === null ? (
          <>
            <Button onClick={onClose}>{t("users.cancel")}</Button>
            <Button variant="primary" pendingSince={action.since} onClick={invite}>
              {t("users.invite")}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              onClick={() => void copyText(issued.url).then((done) => setCopy(done ? "copied" : "failed"))}
            >
              {t("users.invite.copy")}
            </Button>
            <Button variant="primary" onClick={onClose}>
              {t("users.done")}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-s2 p-s3">
        {issued === null ? (
          <TextField
            label={t("users.invite.hint")}
            value={hint}
            onChange={(value) => setHint(value.slice(0, USERS_LIMITS.nameHint))}
            ground="surface"
            autoComplete="off"
          />
        ) : (
          <>
            <p className="text-ui text-fg">
              {t("users.invite.shown", { time: whenText(issued.expiresAt, locale) })}
            </p>
            <label htmlFor={linkId} className="label-hud text-muted">
              {t("users.invite.link")}
            </label>
            <input
              id={linkId}
              ref={input}
              readOnly
              autoComplete="off"
              spellCheck={false}
              value={issued.url}
              className="h-control w-full rounded-sm border border-control-border bg-bg px-s2 font-mono text-code text-fg focus-ring"
            />
            {copy === "idle" ? null : (
              <p role="status" className="text-ui text-muted">
                {t(copy === "copied" ? "users.invite.copied" : "users.invite.copyFailed")}
              </p>
            )}
          </>
        )}
        {action.problem === null ? null : (
          <p role="status" className="text-ui text-err">
            {t(action.problem)}
          </p>
        )}
      </div>
    </Dialog>
  );
}

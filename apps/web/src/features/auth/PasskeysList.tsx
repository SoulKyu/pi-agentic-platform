import type { PasskeyView } from "@pap/contracts";
import { Button, InlineError } from "@pap/ui";
import { useRef, useState } from "react";
import { useLocale, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { AddPasskey } from "./AddPasskey.tsx";
import { InlineAsk } from "./InlineAsk.tsx";
import { useStepUp } from "./StepUp.tsx";
import { withStepUp } from "./step-up.ts";
import { useListing } from "./use-listing.ts";
import { useMutation } from "./use-mutation.ts";
import { whenText } from "./when.ts";

const META = "text-label text-muted";

function PasskeyLine({
  passkey,
  asking,
  busy,
  onAsk,
  onCancel,
  onConfirm,
}: {
  passkey: PasskeyView;
  asking: boolean;
  busy: boolean;
  onAsk(): void;
  onCancel(): void;
  onConfirm(): void;
}) {
  const t = useT();
  const locale = useLocale();
  const created = whenText(passkey.createdAt, locale);
  return (
    <li data-passkey={passkey.id} className="flex flex-col gap-s2 border-b border-border py-s2">
      <div className="flex flex-wrap items-center gap-s2">
        <span className="text-ui text-fg">{t("access.passkeys.created", { date: created })}</span>
        <span className="flex-1" />
        {asking ? null : (
          <Button
            variant="secondary"
            disabled={busy}
            aria-label={t("access.passkeys.removeOne", { date: created })}
            onClick={onAsk}
          >
            {t("access.passkeys.remove")}
          </Button>
        )}
      </div>
      <p className={META}>
        {passkey.lastUsedAt === null
          ? t("access.passkeys.neverUsed")
          : t("access.passkeys.lastUsed", { date: whenText(passkey.lastUsedAt, locale) })}
        {passkey.transports.length === 0
          ? ""
          : ` · ${t("access.passkeys.transports", { list: passkey.transports.join(", ") })}`}
      </p>
      {asking ? (
        <InlineAsk
          question={t("access.passkeys.ask")}
          confirmLabel={t("access.passkeys.confirm")}
          busy={busy}
          onConfirm={onConfirm}
          onCancel={onCancel}
        >
          <p className="text-ui text-muted">{t("access.passkeys.askNote")}</p>
        </InlineAsk>
      ) : null}
    </li>
  );
}

/** Null when the person cancelled the password prompt: that is a choice, not an error. */
async function removePasskey(passkeyId: string, ask: () => Promise<boolean>): Promise<number | null> {
  const rpc = getRuntime().rpc;
  let cancelled = false;
  try {
    const done = await withStepUp(
      (commandId) => rpc.call("auth.passkeys.remove", { passkeyId }, { commandId }),
      async () => {
        const confirmed = await ask();
        cancelled = !confirmed;
        return confirmed;
      },
      rpc.newCommandId(),
    );
    return done.revoked;
  } catch (failure) {
    if (cancelled) return null;
    throw failure;
  }
}

/**
 * The owner's passkeys (`auth.passkeys.*`, M5R96): add one, or remove one behind a step-up. Removing a passkey signs
 * out the browsers it opened; the answer says how many.
 */
export function PasskeysList({
  passkeysAvailable,
  onSignedOut,
}: {
  readonly passkeysAvailable: boolean;
  onSignedOut(): void;
}) {
  const t = useT();
  const list = useListing(() => getRuntime().rpc.call("auth.passkeys.list", {}));
  const { busy, error, run } = useMutation(list.reload);
  const stepUp = useStepUp(onSignedOut);
  const [asking, setAsking] = useState<string | null>(null);
  const [revoked, setRevoked] = useState<number | null>(null);
  const [added, setAdded] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const remove = (passkey: PasskeyView) => {
    setRevoked(null);
    setAdded(false);
    setAsking(null);
    // The inline question unmounts now and the prompt restores focus to whatever was focused when it opened:
    // the heading stays mounted, so focus lands there and not on a detached button.
    heading.current?.focus();
    run(async () => {
      const revokedCount = await removePasskey(passkey.id, stepUp.ask);
      if (revokedCount !== null) setRevoked(revokedCount);
    });
  };

  const passkeys = list.value?.passkeys ?? null;
  return (
    <section className="flex w-full flex-col gap-s2">
      <h2 ref={heading} tabIndex={-1} className="text-ui font-semibold text-fg outline-none">
        {t("access.passkeys.title")}
      </h2>
      <p className={META}>{t("access.passkeys.hint")}</p>
      {list.error ? (
        <div className="flex flex-col items-start gap-s2">
          <InlineError announce="background">{list.error}</InlineError>
          <Button variant="secondary" onClick={list.reload}>
            {t("access.retry")}
          </Button>
        </div>
      ) : null}
      {error ? <InlineError announce="action">{error}</InlineError> : null}
      {revoked !== null && revoked > 0 ? (
        <p role="status" className="text-ui text-muted">
          {t(revoked === 1 ? "access.passkeys.signedOut.one" : "access.passkeys.signedOut.other", {
            count: revoked,
          })}
        </p>
      ) : null}
      {revoked !== null && passkeys?.length === 0 ? (
        <p role="status" className="text-ui text-muted">
          {t("access.passkeys.lastGone")}
        </p>
      ) : null}
      {passkeys === null ? (
        list.error ? null : (
          <p className={META}>{t("access.passkeys.loading")}</p>
        )
      ) : passkeys.length === 0 ? (
        <p className={META}>{t("access.passkeys.empty")}</p>
      ) : (
        <ul className="flex flex-col">
          {passkeys.map((passkey) => (
            <PasskeyLine
              key={passkey.id}
              passkey={passkey}
              asking={asking === passkey.id}
              busy={busy}
              onAsk={() => setAsking(passkey.id)}
              onCancel={() => setAsking(null)}
              onConfirm={() => remove(passkey)}
            />
          ))}
        </ul>
      )}
      {passkeysAvailable ? (
        <div className="flex flex-col items-start gap-s2">
          <AddPasskey
            onAdded={() => {
              setAdded(true);
              list.reload();
            }}
            onSignedOut={onSignedOut}
          />
          {added ? (
            <p role="status" className="text-ui text-muted">
              {t("account.passkeyAdded")}
            </p>
          ) : null}
        </div>
      ) : null}
      {stepUp.prompt}
    </section>
  );
}

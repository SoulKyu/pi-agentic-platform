import type { TokenView } from "@pap/contracts";
import { Button, Chip, Collapsible, EmptyState, InlineError, LoadingLine } from "@pap/ui";
import { useState } from "react";
import { useLocale, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { InlineAsk } from "./InlineAsk.tsx";
import { TokenCreate } from "./TokenCreate.tsx";
import { isExpired } from "./tokens.vm.ts";
import { useListing } from "./use-listing.ts";
import { useMutation } from "./use-mutation.ts";
import { whenText } from "./when.ts";

const META = "text-label text-muted";

function TokenLine({
  token,
  now,
  asking,
  busy,
  onAsk,
  onCancel,
  onConfirm,
}: {
  token: TokenView;
  now: number;
  asking: boolean;
  busy: boolean;
  onAsk(): void;
  onCancel(): void;
  onConfirm(): void;
}) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const count = token.permissions.length;
  const countText = t(count === 1 ? "access.tokens.count.one" : "access.tokens.count.other", { count });
  return (
    <li data-token={token.id} className="flex flex-col gap-s2 border-b border-border py-s2">
      <div className="flex flex-wrap items-center gap-s2">
        <span className="text-ui font-semibold text-fg">{token.name}</span>
        <span className="font-mono text-ui text-muted">…{token.hint}</span>
        {isExpired(token.expiresAt, now) ? <Chip tone="err" label={t("access.tokens.expired")} /> : null}
        <span className="flex-1" />
        {asking ? null : (
          <Button
            variant="secondary"
            disabled={busy}
            aria-label={t("access.tokens.revokeOne", { name: token.name })}
            onClick={onAsk}
          >
            {t("access.tokens.revoke")}
          </Button>
        )}
      </div>
      <p className={META}>
        {t("access.tokens.createdOn", { date: whenText(token.createdAt, locale) })} ·{" "}
        {t("access.tokens.expires", { date: whenText(token.expiresAt, locale) })} ·{" "}
        {t("access.tokens.lastUsed", {
          when: token.lastUsedAt === null ? t("access.tokens.never") : whenText(token.lastUsedAt, locale),
        })}
      </p>
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        trigger={<span className="text-ui text-muted">{countText}</span>}
      >
        <ul className="flex flex-col gap-s1 pt-s1">
          {token.permissions.map((permission) => (
            <li key={permission} className="font-mono text-ui text-fg">
              {permission}
            </li>
          ))}
        </ul>
      </Collapsible>
      {asking ? (
        <InlineAsk
          question={t("access.tokens.ask")}
          confirmLabel={t("access.tokens.confirm")}
          busy={busy}
          onConfirm={onConfirm}
          onCancel={onCancel}
        >
          <p className="text-ui text-muted">{t("access.tokens.askNote")}</p>
        </InlineAsk>
      ) : null}
    </li>
  );
}

/** API tokens of the owner (`auth.tokens.*`, M5R97 to M5R99): create (value shown once), list, revoke. */
export function TokensPanel({ onSignedOut }: { onSignedOut(): void }) {
  const t = useT();
  // `now` is read when the answer arrives, so the render stays pure.
  const list = useListing(() =>
    getRuntime()
      .rpc.call("auth.tokens.list", {})
      .then((answer) => ({ ...answer, now: Date.now() })),
  );
  const { busy, error, run } = useMutation(list.reload);
  const [asking, setAsking] = useState<string | null>(null);

  const revoke = (token: TokenView) => {
    setAsking(null);
    run(async () => {
      const rpc = getRuntime().rpc;
      await rpc.call("auth.tokens.revoke", { tokenId: token.id }, { commandId: rpc.newCommandId() });
    });
  };

  const tokens = list.value?.tokens ?? null;
  return (
    <section id="tokens" className="flex w-full flex-col gap-s2">
      <h2 className="text-ui font-semibold text-fg">{t("access.tokens.title")}</h2>
      <p className={META}>{t("access.tokens.hint")}</p>
      <TokenCreate onCreated={list.reload} onSignedOut={onSignedOut} />
      {list.error ? (
        <div className="flex flex-col items-start gap-s2">
          <InlineError announce="background">{list.error}</InlineError>
          <Button variant="secondary" onClick={list.reload}>
            {t("access.retry")}
          </Button>
        </div>
      ) : null}
      {error ? <InlineError announce="action">{error}</InlineError> : null}
      {tokens === null ? (
        list.error ? null : (
          <LoadingLine label={t("access.tokens.loading")} />
        )
      ) : tokens.length === 0 ? (
        <EmptyState level={3} title={t("access.tokens.emptyTitle")} purpose={t("access.tokens.empty")} />
      ) : (
        <ul className="flex flex-col">
          {tokens.map((token) => (
            <TokenLine
              key={token.id}
              token={token}
              now={list.value?.now ?? 0}
              asking={asking === token.id}
              busy={busy}
              onAsk={() => setAsking(token.id)}
              onCancel={() => setAsking(null)}
              onConfirm={() => revoke(token)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

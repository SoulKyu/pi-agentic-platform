import type { DeviceView } from "@pap/contracts";
import { Button, Chip, InlineError, LoadingLine } from "@pap/ui";
import { useState } from "react";
import { useLocale, useT, type MessageKey } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { InlineAsk } from "./InlineAsk.tsx";
import { useListing } from "./use-listing.ts";
import { useMutation } from "./use-mutation.ts";
import { whenText } from "./when.ts";

const META = "text-label text-muted";
type Asking = { readonly kind: "one"; readonly id: string } | { readonly kind: "others" } | null;

function DeviceLine({
  device,
  asking,
  busy,
  onAsk,
  onCancel,
  onConfirm,
}: {
  device: DeviceView;
  asking: boolean;
  busy: boolean;
  onAsk(): void;
  onCancel(): void;
  onConfirm(): void;
}) {
  const t = useT();
  const locale = useLocale();
  const label = t("access.devices.label", {
    browser: t(`access.devices.browser.${device.browser}`),
    system: t(`access.devices.system.${device.os}`),
  });
  return (
    <li data-device={device.id} className="flex flex-col gap-s2 border-b border-border py-s2">
      <div className="flex flex-wrap items-center gap-s2">
        <span className="text-ui font-semibold text-fg">{label}</span>
        {device.current ? <Chip tone="run" label={t("access.devices.current")} /> : null}
        <span className="flex-1" />
        {asking ? null : (
          <Button
            variant="secondary"
            disabled={busy}
            aria-label={t("access.devices.revokeOne", { device: label })}
            onClick={onAsk}
          >
            {t("access.devices.revoke")}
          </Button>
        )}
      </div>
      <p className={META}>
        {[
          device.ip === null ? null : t("access.devices.address", { ip: device.ip }),
          device.method === null
            ? null
            : t("access.devices.signedInBy", { method: t(`access.devices.method.${device.method}`) }),
        ]
          .filter((part) => part !== null)
          .join(" · ")}
      </p>
      <p className={META}>
        {t("access.devices.created", { date: whenText(device.createdAt, locale) })} ·{" "}
        {t("access.devices.lastSeen", { date: whenText(device.lastSeenAt, locale) })}
      </p>
      {asking ? (
        <InlineAsk
          question={t("access.devices.askOne")}
          confirmLabel={t("access.devices.confirmOne")}
          busy={busy}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      ) : null}
    </li>
  );
}

const signedOutKey = (count: number): MessageKey =>
  count === 0
    ? "access.devices.signedOut.none"
    : count === 1
      ? "access.devices.signedOut.one"
      : "access.devices.signedOut.other";

async function revokeDevice(device: DeviceView, signOutHere: () => void): Promise<void> {
  const rpc = getRuntime().rpc;
  try {
    await rpc.call("auth.devices.revoke", { deviceId: device.id }, { commandId: rpc.newCommandId() });
  } catch (failure) {
    // Revoking this browser may close the socket before the answer arrives: the sign-out flow asks the server.
    if (!(device.current && failure instanceof RpcError && failure.code === "connection_lost")) throw failure;
  }
  if (device.current) signOutHere();
}

/** Browser sessions of the owner (`auth.devices.*`, M5R95): revoke one, or every other one. */
export function DevicesList({ signOutHere }: { signOutHere(): void }) {
  const t = useT();
  const list = useListing(() => getRuntime().rpc.call("auth.devices.list", {}));
  const { busy, error, run } = useMutation(list.reload);
  const [asking, setAsking] = useState<Asking>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const revoke = (device: DeviceView) => {
    setNotice(null);
    setAsking(null);
    run(() => revokeDevice(device, signOutHere));
  };
  const revokeOthers = () => {
    setNotice(null);
    setAsking(null);
    run(async () => {
      const rpc = getRuntime().rpc;
      const done = await rpc.call("auth.devices.revokeOthers", {}, { commandId: rpc.newCommandId() });
      setNotice(t(signedOutKey(done.revoked), { count: done.revoked }));
    });
  };

  const devices = list.value?.devices ?? null;
  return (
    <section className="flex w-full flex-col gap-s2">
      <h2 className="text-ui font-semibold text-fg">{t("access.devices.title")}</h2>
      <p className={META}>{t("access.devices.hint")}</p>
      {list.error ? (
        <div className="flex flex-col items-start gap-s2">
          <InlineError announce="background">{list.error}</InlineError>
          <Button variant="secondary" onClick={list.reload}>
            {t("access.retry")}
          </Button>
        </div>
      ) : null}
      {error ? <InlineError announce="action">{error}</InlineError> : null}
      {notice ? (
        <p role="status" className="text-ui text-muted">
          {notice}
        </p>
      ) : null}
      {devices === null ? (
        list.error ? null : (
          <LoadingLine label={t("access.devices.loading")} />
        )
      ) : (
        <ul className="flex flex-col">
          {devices.map((device) => (
            <DeviceLine
              key={device.id}
              device={device}
              asking={asking?.kind === "one" && asking.id === device.id}
              busy={busy}
              onAsk={() => setAsking({ kind: "one", id: device.id })}
              onCancel={() => setAsking(null)}
              onConfirm={() => revoke(device)}
            />
          ))}
        </ul>
      )}
      {devices !== null && devices.some((device) => !device.current) ? (
        asking?.kind === "others" ? (
          <InlineAsk
            question={t("access.devices.askOthers")}
            confirmLabel={t("access.devices.confirmOthers")}
            busy={busy}
            onConfirm={revokeOthers}
            onCancel={() => setAsking(null)}
          >
            <p className="text-ui text-muted">
              {t("access.devices.tokensNote")}{" "}
              <a href="#tokens" className="text-fg underline focus-ring">
                {t("access.devices.tokensLink")}
              </a>
              .
            </p>
          </InlineAsk>
        ) : (
          <Button variant="secondary" disabled={busy} onClick={() => setAsking({ kind: "others" })}>
            {t("access.devices.revokeOthers")}
          </Button>
        )
      ) : null}
    </section>
  );
}

import { Button, Chip, useIsPhone } from "@pap/ui";
import { useEffect, useRef, useState } from "react";
import { formatAge } from "../../i18n/age.ts";
import { useLocale, useT } from "../../i18n/index.ts";
import type { DeviceRow } from "./notifications.vm.ts";

/**
 * The registered devices: a label the device wrote (shown as text), the push service's host, and a revoke that asks first
 * with a sentence naming the device. Never an endpoint or a key (M12R10: the list does not carry them).
 */
export function DevicesList({
  rows,
  now,
  busy,
  onRevoke,
}: {
  readonly rows: readonly DeviceRow[];
  readonly now: number;
  readonly busy: boolean;
  onRevoke(row: DeviceRow): void;
}) {
  const t = useT();
  const locale = useLocale();
  const phone = useIsPhone();
  const [asking, setAsking] = useState<string | null>(null);
  // After Cancel, focus goes back to the button that opened the question.
  const refocus = useRef<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const id = refocus.current;
    if (id === null || asking !== null) return;
    refocus.current = null;
    list.current
      ?.querySelector<HTMLElement>(`[data-device="${CSS.escape(id)}"] button[data-revoke]`)
      ?.focus();
  }, [asking]);
  if (rows.length === 0) return <p className="text-ui text-muted">{t("notifications.devices.empty")}</p>;
  return (
    <ul ref={list} data-devices="" data-layout={phone ? "stacked" : "wide"} className="flex flex-col gap-s2">
      {rows.map((row) => {
        const name = row.label === "" ? t("notifications.devices.unnamed") : row.label;
        return (
          <li
            key={row.id}
            data-device={row.id}
            className={`flex gap-s2 border border-border p-s2 ${phone ? "flex-col" : "items-start justify-between"}`}
          >
            <div className="flex min-w-0 flex-col gap-s1">
              <p className="flex flex-wrap items-center gap-s2 text-ui text-fg">
                <span className="min-w-0 break-words">{name}</span>
                {row.current ? <Chip tone="ok" label={t("notifications.devices.current")} /> : null}
              </p>
              <p className="text-ui text-muted">{t("notifications.devices.host", { host: row.host })}</p>
              <p className="text-ui text-muted">
                {t("notifications.devices.created", {
                  date: new Date(row.createdAt).toLocaleDateString(locale),
                })}
                {" · "}
                {row.lastOkAt === null
                  ? t("notifications.devices.neverOk")
                  : t("notifications.devices.lastOk", { age: formatAge(now, row.lastOkAt, t) })}
              </p>
            </div>
            {asking === row.id ? (
              <div className="flex flex-col gap-s2">
                <p role="alert" className="text-ui text-fg">
                  {t("notifications.devices.confirm", { label: name })}
                </p>
                <div className="flex gap-s2">
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => {
                      setAsking(null);
                      onRevoke(row);
                    }}
                  >
                    {t("notifications.devices.confirmYes")}
                  </Button>
                  <Button
                    onClick={() => {
                      refocus.current = row.id;
                      setAsking(null);
                    }}
                  >
                    {t("notifications.devices.cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                data-revoke=""
                aria-label={t("notifications.devices.revokeNamed", { label: name })}
                disabled={busy}
                onClick={() => setAsking(row.id)}
              >
                {t("notifications.devices.revoke")}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

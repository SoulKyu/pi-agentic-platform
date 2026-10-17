import "../../i18n/register-notifications.ts";
import "../../i18n/register-push.ts";
import { Button, usePendingAction } from "@pap/ui";
import { useMemo, useState, type ReactNode } from "react";
import { getLocale, useT, type MessageKey } from "../../i18n/index.ts";
import { getRuntime, RpcError, windowTimers } from "../../runtime/index.ts";
import type { Timers } from "../../runtime/connection.ts";
import { usePwa } from "../../stores/pwa.ts";
import { ClassToggles } from "./ClassToggles.tsx";
import { DevicesList } from "./DevicesList.tsx";
import { MuteControl } from "./MuteControl.tsx";
import { deviceRows, muteUntilOf, statusView, type MutePreset } from "./notifications.vm.ts";
import { browserPushEnv, type PushEnv } from "./push-client.ts";
import { enableFailureKey } from "./messages.ts";
import { saveNotifications } from "./save-notifications.ts";
import { disableThisDevice, enableThisDevice } from "./start.ts";
import { useNotifications, type NotificationFacts } from "./use-notifications.ts";

type Notice = { readonly tone: "ok" | "error"; readonly text: string } | null;

export interface NotificationsPanelProps {
  /** Test seams; the page's own objects by default. */
  readonly env?: PushEnv;
  readonly timers?: Timers;
  readonly now?: () => number;
  /** The link to Settings > Automation, where quiet hours are set (rendered by the route, which owns the router). */
  automationLink(label: string): ReactNode;
}

/** Settings > Notifications (M12): status, this device, the devices, the classes, the mute and the names option. */
export function NotificationsPanel(props: NotificationsPanelProps) {
  const t = useT();
  const rpc = getRuntime().rpc;
  const env = useMemo(() => props.env ?? browserPushEnv(getLocale), [props.env]);
  const timers = props.timers ?? windowTimers;
  const now = props.now ?? Date.now;
  const { loaded, reload, setDoc } = useNotifications(rpc, env);
  const needsReenable = usePwa((state) => state.needsReenable);
  const working = usePendingAction();
  const testing = usePendingAction();
  const [notice, setNotice] = useState<Notice>(null);
  const [testNotice, setTestNotice] = useState<Notice>(null);

  if (loaded.kind === "loading")
    return (
      <p role="status" className="text-ui text-muted">
        {t("notifications.loading")}
      </p>
    );
  if (loaded.kind === "failed")
    return (
      <div className="flex flex-col items-start gap-s2">
        <p role="alert" className="text-ui text-attn">
          {t("notifications.loadFailed")}
        </p>
        <Button onClick={reload}>{t("notifications.retry")}</Button>
      </div>
    );

  const { facts } = loaded;
  const view = statusView({
    config: facts.config,
    devices: facts.devices,
    support: env.support(),
    browserSubscribed: facts.browserSubscribed,
    needsReenable,
  });
  const fail = (key: MessageKey) => setNotice({ tone: "error", text: t(key) });

  const enable = () =>
    void working.run(async () => {
      setNotice(null);
      const result = await enableThisDevice(rpc, timers, env);
      if (!result.ok) fail(enableFailureKey(result.reason));
      reload();
    });
  const disable = () =>
    void working.run(async () => {
      setNotice(null);
      if (!(await disableThisDevice(rpc, timers, view.current?.id ?? null, env)))
        fail("notifications.devices.revokeFailed");
      reload();
    });
  const revoke = (id: string) =>
    void working.run(async () => {
      setNotice(null);
      try {
        await rpc.call("push.revoke", { id });
      } catch {
        fail("notifications.devices.revokeFailed");
      }
      reload();
    });
  const save = (change: Parameters<typeof saveNotifications>[1]) =>
    void working.run(async () => {
      setNotice(null);
      try {
        setDoc(await saveNotifications(rpc, change));
      } catch (error) {
        fail(
          error instanceof RpcError && error.code === "conflict"
            ? "notifications.conflict"
            : "notifications.saveFailed",
        );
      }
    });
  const sendTest = () =>
    void testing.run(async () => {
      setTestNotice(null);
      try {
        const { delivered, dropped } = await rpc.call("push.test", {});
        setTestNotice({ tone: "ok", text: t("notifications.test.result", { delivered, dropped }) });
      } catch (error) {
        const limited = error instanceof RpcError && error.code === "rate_limited";
        setTestNotice({
          tone: "error",
          text: t(limited ? "notifications.test.rate_limited" : "notifications.test.failed"),
        });
      }
    });

  return (
    <div data-notifications-settings="" className="flex flex-col gap-s6">
      <StatusBlock view={view} />
      <ThisDevice
        view={view}
        busy={working.since !== null}
        pendingSince={working.since}
        onEnable={enable}
        onDisable={disable}
      />
      {notice === null ? null : (
        <p role="alert" className={`text-ui ${notice.tone === "error" ? "text-err" : "text-fg"}`}>
          {notice.text}
        </p>
      )}
      <section className="flex flex-col gap-s3" aria-labelledby="notifications-devices">
        <h2 id="notifications-devices" className="text-h2 text-fg">
          {t("notifications.devices.title")}
        </h2>
        <DevicesList
          rows={deviceRows(facts.devices)}
          now={now()}
          busy={working.since !== null}
          onRevoke={(row) => (row.current ? disable() : revoke(row.id))}
        />
        <div className="flex flex-col items-start gap-s2">
          <Button disabled={testing.since !== null} pendingSince={testing.since} onClick={sendTest}>
            {t("notifications.test")}
          </Button>
          {testNotice === null ? null : (
            <p role="status" className={`text-ui ${testNotice.tone === "error" ? "text-err" : "text-muted"}`}>
              {testNotice.text}
            </p>
          )}
        </div>
      </section>
      <section className="flex flex-col gap-s3" aria-labelledby="notifications-classes">
        <h2 id="notifications-classes" className="text-h2 text-fg">
          {t("notifications.classes.title")}
        </h2>
        <ClassToggles doc={facts.doc} disabled={working.since !== null} onChange={save} />
        <MuteControl
          muteUntil={facts.doc.muteUntil}
          now={now()}
          disabled={working.since !== null}
          onPick={(preset: MutePreset) => {
            const muteUntil = muteUntilOf(preset, now());
            save((current) => ({ ...current, muteUntil }));
          }}
        />
        <QuietHours quiet={facts.quiet} link={props.automationLink} />
      </section>
    </div>
  );
}

function StatusBlock({ view }: { readonly view: ReturnType<typeof statusView> }) {
  const t = useT();
  return (
    <section data-slot="notifications-status" className="flex max-w-xl flex-col gap-s1">
      <p role="status" className={`text-ui ${view.line.tone === "ok" ? "text-fg" : "text-attn"}`}>
        {t(view.line.key)}
      </p>
      {view.hint === null ? null : <p className="text-ui text-muted">{view.hint}</p>}
      {view.notes.map((key) => (
        <p key={key} className="text-ui text-muted">
          {t(key)}
        </p>
      ))}
      {view.keysReset ? <p className="text-ui text-attn">{t("notifications.keysReset")}</p> : null}
      {view.lastFailure === null ? null : (
        <p className="text-ui text-muted">
          {t("notifications.lastFailure", { reason: t(`notifications.failure.${view.lastFailure}`) })}
        </p>
      )}
      {view.capacity === null ? null : (
        <p className="text-ui text-muted">{t("notifications.cap", { max: view.capacity.max })}</p>
      )}
    </section>
  );
}

function ThisDevice({
  view,
  busy,
  pendingSince,
  onEnable,
  onDisable,
}: {
  readonly view: ReturnType<typeof statusView>;
  readonly busy: boolean;
  readonly pendingSince: number | null;
  onEnable(): void;
  onDisable(): void;
}) {
  const t = useT();
  if (view.action === "none") return null;
  const label =
    view.action === "disable"
      ? "notifications.disable"
      : view.action === "reenable"
        ? "notifications.reenable"
        : "notifications.enable";
  return (
    <div>
      <Button
        variant={view.action === "disable" ? "secondary" : "primary"}
        disabled={busy || view.actionDisabled}
        pendingSince={pendingSince}
        onClick={view.action === "disable" ? onDisable : onEnable}
      >
        {t(label)}
      </Button>
    </div>
  );
}

function QuietHours({
  quiet,
  link,
}: {
  readonly quiet: NotificationFacts["quiet"];
  link(label: string): ReactNode;
}) {
  const t = useT();
  const window = quiet !== null && quiet.from !== quiet.to ? quiet : null;
  return (
    <div data-slot="notifications-quiet" className="flex max-w-xl flex-col gap-s1">
      <p className="text-ui text-fg">
        {window === null
          ? t("notifications.quiet.none")
          : t("notifications.quiet.window", { from: window.from, to: window.to })}
      </p>
      <p className="text-ui text-muted">{t("notifications.quiet.note")}</p>
      <p className="text-ui">{link(t("notifications.quiet.link"))}</p>
    </div>
  );
}

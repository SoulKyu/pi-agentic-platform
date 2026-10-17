import {
  AutomationSettings,
  NotificationsSettings,
  type PushConfig,
  type PushDeviceView,
} from "@pap/contracts";
import { useEffect, useState } from "react";
import type { RpcClient } from "../../runtime/rpc.ts";
import { hasSubscription, type PushEnv } from "./push-client.ts";

export interface NotificationFacts {
  readonly config: PushConfig;
  readonly devices: readonly PushDeviceView[];
  readonly browserSubscribed: boolean;
  readonly doc: NotificationsSettings;
  /** `automation.quietHours`, read only to show it; null when none (or unreadable). */
  readonly quiet: { readonly from: string; readonly to: string } | null;
}
export type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly facts: NotificationFacts };

type Rpc = Pick<RpcClient, "call">;

async function readAll(rpc: Rpc, env: PushEnv): Promise<NotificationFacts> {
  const [config, list, stored, automation, browserSubscribed] = await Promise.all([
    rpc.call("push.config", {}),
    rpc.call("push.list", {}),
    rpc.call("settings.get", { key: "notifications" }),
    // Display only: a failed read hides the line instead of failing the screen.
    rpc.call("settings.get", { key: "automation" }).catch(() => null),
    hasSubscription(env),
  ]);
  const quiet = AutomationSettings.safeParse(automation?.value ?? {});
  return {
    config,
    devices: list.items,
    browserSubscribed,
    doc: NotificationsSettings.parse(stored.value ?? {}),
    quiet: quiet.success ? quiet.data.quietHours : null,
  };
}

/**
 * The screen's reads: the push state, the device list, the `notifications` document and the quiet hours. `reload()`
 * reads them again (the old answer stays on screen meanwhile); `setDoc` puts a saved document in place.
 */
export function useNotifications(rpc: Rpc, env: PushEnv) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [stamp, setStamp] = useState(0);
  useEffect(() => {
    let live = true;
    readAll(rpc, env).then(
      (facts) => live && setLoaded({ kind: "ready", facts }),
      () => live && setLoaded({ kind: "failed" }),
    );
    return () => {
      live = false;
    };
  }, [rpc, env, stamp]);
  return {
    loaded,
    reload: () => {
      setLoaded((now) => (now.kind === "failed" ? { kind: "loading" } : now));
      setStamp((value) => value + 1);
    },
    setDoc: (doc: NotificationsSettings) =>
      setLoaded((now) => (now.kind === "ready" ? { kind: "ready", facts: { ...now.facts, doc } } : now)),
  };
}

import { getLocale } from "../../i18n/index.ts";
import type { Timers } from "../../runtime/connection.ts";
import type { RpcClient } from "../../runtime/rpc.ts";
import { bindPush } from "./bind.ts";
import {
  browserPushEnv,
  disablePush,
  enablePush,
  releaseDevice,
  type EnableResult,
  type PushEnv,
} from "./push-client.ts";

type Rpc = Pick<RpcClient, "call">;

/** The one lazy entry the shell and the banner import by path (a barrel would pull the push client into the first load). */
export async function rebindDevice(
  rpc: Rpc,
  timers: Timers,
  env: PushEnv = browserPushEnv(getLocale),
): Promise<void> {
  await bindPush({ rpc, timers, env });
}

/**
 * `pushsubscriptionchange`: subscribe again without a prompt, only when the permission is already granted and the daemon
 * lists a row for this login. A device with no row (revoked, or signed out) is enrolled by the owner's click alone.
 */
export async function resubscribeDevice(
  rpc: Rpc,
  timers: Timers,
  env: PushEnv = browserPushEnv(getLocale),
): Promise<void> {
  if (env.permission() !== "granted") return;
  try {
    const { items } = await rpc.call("push.list", {});
    if (!items.some((item) => item.current)) return;
  } catch {
    return; // not signed in or unreachable: the next start binds it again
  }
  await enablePush({ rpc, timers, env });
}

/** The enable button and the re-enable banner. Call it from the click. */
export function enableThisDevice(
  rpc: Rpc,
  timers: Timers,
  env: PushEnv = browserPushEnv(getLocale),
): Promise<EnableResult> {
  return enablePush({ rpc, timers, env });
}

export function releaseThisDevice(
  rpc: Rpc,
  timers: Timers,
  env: PushEnv = browserPushEnv(getLocale),
): Promise<boolean> {
  return releaseDevice({ rpc, timers, env });
}

/** The Disable button: revoke this device's row when the list names one, else drop the browser subscription alone. */
export function disableThisDevice(
  rpc: Rpc,
  timers: Timers,
  rowId: string | null,
  env: PushEnv = browserPushEnv(getLocale),
): Promise<boolean> {
  return rowId === null ? releaseDevice({ rpc, timers, env }) : disablePush({ rpc, timers, env }, rowId);
}

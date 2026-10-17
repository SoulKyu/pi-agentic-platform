import { reportClientIssue } from "../../lib/report.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { usePwa } from "../../stores/pwa.ts";
import { usesKey, type PushDeps, type PushSubscriptionLike } from "./push-client.ts";

/** The daemon allows one `push.subscribe` per owner every 6 s; a second device's re-bind waits that window out. */
const RATE_WINDOW_MS = 6_500;
const RETRIES = 2;

const wait = (deps: PushDeps, ms: number) =>
  new Promise<void>((resolve) => void deps.timers.set(resolve, ms));

async function refresh(
  deps: PushDeps,
  subscription: PushSubscriptionLike,
): Promise<"ok" | "revoked" | "failed"> {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return "failed";
  const body = {
    subscription: {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      locale: deps.env.locale(),
      label: deps.env.label(),
    },
  };
  for (let attempt = 0; ; attempt++) {
    try {
      await deps.rpc.call("push.subscribe", body);
      return "ok";
    } catch (error) {
      // The owner revoked this very endpoint: it is not enrolled again (W6-R15).
      if (error instanceof RpcError && error.code === "push_revoked") return "revoked";
      const limited = error instanceof RpcError && error.code === "rate_limited";
      if (!limited || attempt >= RETRIES) return "failed";
      await wait(deps, RATE_WINDOW_MS);
    }
  }
}

/**
 * At each start with the permission granted (M12R12): a subscription made with another key than the server's is dropped
 * and one tap re-enables it; otherwise the row is bound to this login again. It never drops a subscription it cannot
 * compare: a server whose keys are unreadable or whose boot is read-only answers `off`.
 */
export async function bindPush(deps: PushDeps): Promise<"none" | "refreshed" | "needs_reenable"> {
  if (deps.env.permission() !== "granted") return "none";
  let subscription: PushSubscriptionLike | null | undefined;
  try {
    subscription = await (await deps.env.current())?.pushManager.getSubscription();
  } catch {
    return "none";
  }
  if (!subscription) return "none";
  let config;
  try {
    config = await deps.rpc.call("push.config", {});
  } catch {
    reportClientIssue("push_bind_failed");
    return "none";
  }
  if (config.status !== "on" || config.publicKey === null) return "none";
  if (!usesKey(subscription, config.publicKey)) {
    await subscription.unsubscribe().catch(() => reportClientIssue("push_unsubscribe_failed"));
    usePwa.getState().setNeedsReenable(true);
    return "needs_reenable";
  }
  const refreshed = await refresh(deps, subscription);
  if (refreshed === "ok") return "refreshed";
  if (refreshed === "revoked") {
    // Drop the browser's subscription too: the next Enable makes a new endpoint, which the daemon accepts.
    await subscription.unsubscribe().catch(() => reportClientIssue("push_unsubscribe_failed"));
    usePwa.getState().setNeedsReenable(true);
    return "needs_reenable";
  }
  reportClientIssue("push_bind_failed");
  return "none";
}

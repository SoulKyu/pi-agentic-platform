import { reportClientIssue } from "../../lib/report.ts";
import type { Timers } from "../../runtime/connection.ts";
import { RpcError, type RpcClient } from "../../runtime/rpc.ts";
import { usePwa } from "../../stores/pwa.ts";
import { deviceLabel, pushSupport, type PushSupport } from "./support.ts";

/** The slice of `PushSubscription` this client uses. */
export interface PushSubscriptionLike {
  readonly options: { readonly applicationServerKey: ArrayBuffer | null };
  toJSON(): { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  unsubscribe(): Promise<boolean>;
}
export interface PushRegistrationLike {
  readonly pushManager: {
    getSubscription(): Promise<PushSubscriptionLike | null>;
    subscribe(options: {
      userVisibleOnly: true;
      applicationServerKey: Uint8Array;
    }): Promise<PushSubscriptionLike>;
  };
}

/** Everything the page hands in, so a test drives each of them. */
export interface PushEnv {
  support(): PushSupport;
  permission(): NotificationPermission | undefined;
  requestPermission(): Promise<NotificationPermission>;
  /** The registration if there is one, without waiting for a worker. */
  current(): Promise<PushRegistrationLike | null>;
  /** `serviceWorker.ready`: it never settles when no worker installs, so callers bound it. */
  ready(): Promise<PushRegistrationLike>;
  locale(): "en" | "fr";
  label(): string;
}
export interface PushDeps {
  readonly rpc: Pick<RpcClient, "call">;
  readonly env: PushEnv;
  readonly timers: Timers;
}

export type EnableResult =
  { ok: true; id: string } | { ok: false; reason: PushSupport | "refused" | "capacity" | "rpc" };

const READY_DEADLINE_MS = 8_000;

export const toBase64Url = (buffer: ArrayBuffer): string => {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const fromBase64Url = (text: string): Uint8Array => {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

/** True when the subscription was made with the server's public key. */
export function usesKey(subscription: PushSubscriptionLike, publicKey: string): boolean {
  const key = subscription.options.applicationServerKey;
  return key !== null && toBase64Url(key) === publicKey;
}

/** `ready` with a deadline: a worker that never installs (a redirecting proxy) must show a failure, not hang. */
function readyWithin(env: PushEnv, timers: Timers): Promise<PushRegistrationLike | null> {
  return new Promise((resolve) => {
    const timer = timers.set(() => resolve(null), READY_DEADLINE_MS);
    env.ready().then(
      (registration) => {
        timers.clear(timer);
        resolve(registration);
      },
      () => {
        timers.clear(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Subscribes this device. Call it from a click: the permission prompt needs the gesture on iOS (M12R29), so it is the
 * first thing awaited.
 */
export async function enablePush({ rpc, env, timers }: PushDeps): Promise<EnableResult> {
  const support = env.support();
  if (support !== "supported") return { ok: false, reason: support };
  const permission = env.permission() === "granted" ? "granted" : await env.requestPermission();
  if (permission !== "granted") return { ok: false, reason: "denied" };
  let config;
  try {
    config = await rpc.call("push.config", {});
  } catch {
    return { ok: false, reason: "rpc" };
  }
  if (config.status !== "on" || config.publicKey === null) return { ok: false, reason: "refused" };
  const registration = await readyWithin(env, timers);
  if (!registration) {
    usePwa.getState().setRegistrationFailed(true);
    return { ok: false, reason: "no_service_worker" };
  }
  let subscription: PushSubscriptionLike | null;
  let created = false;
  try {
    subscription = await registration.pushManager.getSubscription();
    if (subscription && !usesKey(subscription, config.publicKey)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: fromBase64Url(config.publicKey),
      });
      created = true;
    }
  } catch {
    return { ok: false, reason: "rpc" };
  }
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    await subscription.unsubscribe().catch(() => false);
    return { ok: false, reason: "unsupported" };
  }
  const register = (endpoint: string, keys: { p256dh: string; auth: string }) =>
    rpc.call("push.subscribe", {
      subscription: { endpoint, keys, locale: env.locale(), label: env.label() },
    });
  try {
    let id: string;
    try {
      ({ id } = await register(json.endpoint, { p256dh: json.keys.p256dh, auth: json.keys.auth }));
    } catch (error) {
      if (!(error instanceof RpcError && error.code === "push_revoked") || created) throw error;
      // The owner revoked this device's endpoint: Enable is the owner's word, so it gets a new endpoint (W6-R15).
      await subscription.unsubscribe();
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: fromBase64Url(config.publicKey),
      });
      created = true;
      const fresh = subscription.toJSON();
      if (!fresh.endpoint || !fresh.keys?.p256dh || !fresh.keys.auth) throw error;
      ({ id } = await register(fresh.endpoint, { p256dh: fresh.keys.p256dh, auth: fresh.keys.auth }));
    }
    usePwa.getState().setNeedsReenable(false);
    return { ok: true, id };
  } catch (error) {
    const capacity = error instanceof RpcError && error.code === "capacity";
    // `rate_limited` is a refusal of the moment, not of this subscription: it is kept, so the next tap (the re-enable
    // button shows for a subscription with no row) registers it without a new browser subscription or prompt.
    const limited = error instanceof RpcError && error.code === "rate_limited";
    // No row exists for it: a subscription the browser keeps would be an orphan the owner cannot see or revoke.
    if ((created || capacity) && !limited)
      await subscription.unsubscribe().catch(() => reportClientIssue("push_unsubscribe_failed"));
    return { ok: false, reason: capacity ? "capacity" : "rpc" };
  }
}

/** True when this browser holds a push subscription (with or without a row on the server). */
export async function hasSubscription(env: PushEnv): Promise<boolean> {
  try {
    return Boolean(await (await env.current())?.pushManager.getSubscription());
  } catch {
    return false;
  }
}

async function unsubscribeHere(env: PushEnv): Promise<void> {
  try {
    const subscription = await (await env.current())?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  } catch {
    reportClientIssue("push_unsubscribe_failed");
  }
}

/** Revoke the row first, then drop the browser subscription, also when the revoke fails. */
export async function disablePush({ rpc, env }: PushDeps, id: string): Promise<boolean> {
  let revoked = true;
  try {
    await rpc.call("push.revoke", { id });
  } catch {
    revoked = false;
    reportClientIssue("push_revoke_failed");
  }
  await unsubscribeHere(env);
  return revoked;
}

/** Sign-out: this device's row (the list marks it `current`), then the browser subscription. */
export async function releaseDevice(deps: PushDeps): Promise<boolean> {
  const subscription = await (
    await deps.env.current().catch(() => null)
  )?.pushManager
    .getSubscription()
    .catch(() => null);
  if (!subscription) return true;
  let id: string | undefined;
  let listed = true;
  try {
    id = (await deps.rpc.call("push.list", {})).items.find((device) => device.current)?.id;
  } catch {
    listed = false;
    reportClientIssue("push_revoke_failed");
  }
  if (id !== undefined) return disablePush(deps, id);
  await unsubscribeHere(deps.env);
  return listed;
}

/** The browser's objects for a real page. */
export function browserPushEnv(getLocale: () => "en" | "fr"): PushEnv {
  const container = "serviceWorker" in navigator ? navigator.serviceWorker : undefined;
  const wrap = (registration: ServiceWorkerRegistration | undefined) =>
    registration ? (registration as unknown as PushRegistrationLike) : null;
  return {
    support: () =>
      pushSupport({
        isSecureContext: window.isSecureContext,
        hasServiceWorker: container !== undefined,
        hasPushManager: "PushManager" in window,
        hasNotification: "Notification" in window,
        permission: "Notification" in window ? Notification.permission : undefined,
        isIos:
          /iPhone|iPad|iPod/.test(navigator.userAgent) ||
          (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
        standalone:
          window.matchMedia("(display-mode: standalone)").matches ||
          (navigator as Navigator & { standalone?: boolean }).standalone === true,
      }),
    permission: () => ("Notification" in window ? Notification.permission : undefined),
    requestPermission: () => Notification.requestPermission(),
    current: async () => wrap(await container?.getRegistration("/")),
    ready: async () => {
      if (!container) throw new Error("no service worker");
      return container.ready as unknown as PushRegistrationLike;
    },
    locale: getLocale,
    label: () => deviceLabel(navigator.userAgent, navigator.platform),
  };
}

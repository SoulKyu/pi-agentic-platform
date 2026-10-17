export type PushSupport =
  | "supported"
  | "insecure"
  | "needs_install_ios"
  | "no_service_worker"
  | "no_push_api"
  | "denied"
  | "unsupported";

export interface PushSupportEnv {
  readonly isSecureContext: boolean;
  readonly hasServiceWorker: boolean;
  readonly hasPushManager: boolean;
  readonly hasNotification: boolean;
  readonly permission: NotificationPermission | undefined;
  readonly isIos: boolean;
  readonly standalone: boolean;
}

/** What this browser can do for push, in the order the owner can act on it (M12R16, M12R29). */
export function pushSupport(env: PushSupportEnv): PushSupport {
  if (!env.isSecureContext) return "insecure";
  // An iOS Safari tab has no PushManager at all: the way forward is the home screen, not a missing API.
  if (env.isIos && !env.standalone) return "needs_install_ios";
  if (!env.hasServiceWorker && !env.hasPushManager && !env.hasNotification) return "unsupported";
  if (!env.hasServiceWorker) return "no_service_worker";
  if (!env.hasPushManager || !env.hasNotification) return "no_push_api";
  if (env.permission === "denied") return "denied";
  return "supported";
}

/** The device's name in the list: a class of browser and system, never the user agent string (M12R9). */
export function deviceLabel(userAgent: string, platform: string): string {
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent)) return "iPad";
  const system = /Android/.test(userAgent)
    ? "Android"
    : /Windows|^Win/.test(userAgent + platform)
      ? "Windows"
      : /Mac/.test(userAgent + platform)
        ? "macOS"
        : /Linux|X11/.test(userAgent + platform)
          ? "Linux"
          : null;
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\/|Chromium\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : null;
  if (browser && system) return `${browser} on ${system}`;
  return system ?? browser ?? "This device";
}

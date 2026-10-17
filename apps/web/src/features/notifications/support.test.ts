import { describe, expect, it } from "vitest";
import { deviceLabel, pushSupport, type PushSupportEnv } from "./support.ts";

const ok: PushSupportEnv = {
  isSecureContext: true,
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  permission: "default",
  isIos: false,
  standalone: false,
};
const env = (over: Partial<PushSupportEnv>): PushSupportEnv => ({ ...ok, ...over });

describe("pushSupport (M12R16, M12R29)", () => {
  it("supports a secure page with the three APIs and a permission still to ask", () => {
    expect(pushSupport(ok)).toBe("supported");
    expect(pushSupport(env({ permission: "granted" }))).toBe("supported");
    expect(pushSupport(env({ permission: undefined }))).toBe("supported");
  });

  it("refuses plain http before anything else", () => {
    expect(pushSupport(env({ isSecureContext: false }))).toBe("insecure");
    expect(pushSupport(env({ isSecureContext: false, isIos: true, hasPushManager: false }))).toBe("insecure");
  });

  it("asks an iOS Safari tab to add pap to the home screen, even though PushManager is absent there", () => {
    expect(pushSupport(env({ isIos: true, hasPushManager: false }))).toBe("needs_install_ios");
    expect(pushSupport(env({ isIos: true, hasPushManager: true }))).toBe("needs_install_ios");
  });

  it("supports a standalone iOS app that has PushManager, and not one that lacks it", () => {
    expect(pushSupport(env({ isIos: true, standalone: true }))).toBe("supported");
    expect(pushSupport(env({ isIos: true, standalone: true, hasPushManager: false }))).toBe("no_push_api");
  });

  it("names the missing API", () => {
    expect(pushSupport(env({ hasServiceWorker: false }))).toBe("no_service_worker");
    expect(pushSupport(env({ hasPushManager: false }))).toBe("no_push_api");
    expect(pushSupport(env({ hasNotification: false }))).toBe("no_push_api");
    expect(pushSupport(env({ hasServiceWorker: false, hasPushManager: false, hasNotification: false }))).toBe(
      "unsupported",
    );
  });

  it("reports a denied permission only when the APIs are all there", () => {
    expect(pushSupport(env({ permission: "denied" }))).toBe("denied");
    expect(pushSupport(env({ permission: "denied", hasServiceWorker: false }))).toBe("no_service_worker");
  });
});

describe("deviceLabel", () => {
  const cases: Array<[string, string, string]> = [
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1",
      "iPhone",
      "iPhone",
    ],
    ["Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15", "iPad", "iPad"],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36",
      "Linux armv8l",
      "Chrome on Android",
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Linux x86_64",
      "Chrome on Linux",
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
      "Linux x86_64",
      "Firefox on Linux",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36 Edg/124.0",
      "Win32",
      "Edge on Windows",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15",
      "MacIntel",
      "Safari on macOS",
    ],
    ["something unknown", "", "This device"],
  ];
  it.each(cases)("%#: classifies without the user agent string", (ua, platform, label) => {
    expect(deviceLabel(ua, platform)).toBe(label);
  });
});

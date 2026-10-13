import { describe, expect, it } from "vitest";
import { deviceLabel } from "./device-label.ts";

describe("deviceLabel", () => {
  it.each([
    [
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      "chrome",
      "linux",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0",
      "edge",
      "windows",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "safari",
      "ios",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0; rv:131.0) Gecko/20100101 Firefox/131.0",
      "firefox",
      "macos",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
      "chrome",
      "android",
    ],
    ["curl/8.5.0", "other", "other"],
    [null, "other", "other"],
  ])("labels %j as %s on %s", (ua, browser, os) => {
    expect(deviceLabel(ua)).toEqual({ browser, os });
  });

  it("reads only the first 256 characters and stays linear on a hostile string", () => {
    const hostile = `${"(".repeat(100_000)}Firefox/1 Linux`;
    expect(deviceLabel(hostile)).toEqual({ browser: "other", os: "other" });
    expect(deviceLabel(`${"x".repeat(250)} Firefox/1`)).toEqual({ browser: "other", os: "other" });
    expect(deviceLabel(`Firefox/1 ${"x".repeat(300)} Linux`)).toEqual({ browser: "firefox", os: "other" });
  });
});

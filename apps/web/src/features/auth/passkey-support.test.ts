// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { passkeysUsable } from "./passkey-support.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("passkeysUsable", () => {
  it("needs the server to allow passkeys and the browser to support WebAuthn", () => {
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    expect(passkeysUsable(true)).toBe(true);
    expect(passkeysUsable(false)).toBe(false);
  });

  it("is false in a browser without WebAuthn, whatever the server says", () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(passkeysUsable(true)).toBe(false);
  });
});

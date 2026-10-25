import { describe, expect, it } from "vitest";
import { authErrorText } from "./auth-error.ts";

const failed = (code: string, retryAfterSeconds: number | null = null) =>
  ({ ok: false, code, retryAfterSeconds }) as const;

describe("authErrorText", () => {
  it("shows the wait of a throttled attempt, one second when the server gave none", () => {
    expect(authErrorText(failed("rate_limited", 4))).toBe("Too many attempts. Wait 4 s.");
    expect(authErrorText(failed("rate_limited"))).toBe("Too many attempts. Wait 1 s.");
  });

  it("lets each screen word `unauthenticated` for itself", () => {
    expect(authErrorText(failed("unauthenticated"))).toBe("Sign in first.");
    expect(authErrorText(failed("unauthenticated"), "login.failed")).toBe("Wrong username or password.");
    expect(authErrorText(failed("unauthenticated"), "setup.missingToken")).toBe(
      "Open the setup link printed in the server log.",
    );
  });

  it("translates the page's own codes, and anything unknown into a generic message", () => {
    expect(authErrorText(failed("password_incorrect"))).toBe("Password incorrect.");
    expect(authErrorText(failed("offline"))).toBe(
      "pap is unreachable: this page cannot reach the daemon. Your drafts stay on this device. Check that pap is running, then retry.",
    );
    expect(authErrorText(failed("teapot"))).toBe(
      "pap hit an unexpected error. The action may not have completed: check its result, then try again. If it repeats, run pap doctor.",
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  ApiKeyValue,
  ERROR_MESSAGES,
  helperErrorCode,
  HELPER_OPS,
  LinkUrl,
  LoginEvent,
  LoginPrompt,
  LoginStreamEvent,
  methods,
  PROVIDER_AUDIT_REASONS,
  STREAMS,
} from "./index.ts";

describe("LinkUrl (M7R58)", () => {
  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "http://evil.test/x",
    "data:text/html,x",
    "//x.test",
  ])("refuses %s", (url) => {
    expect(LinkUrl.safeParse(url).success).toBe(false);
  });
  it.each([
    "https://auth.example.test/authorize?x=1",
    "http://127.0.0.1:1455/cb",
    "http://localhost:3000/cb",
    "http://[::1]:8080/cb",
  ])("accepts %s", (url) => {
    expect(LinkUrl.safeParse(url).success).toBe(true);
  });
  it("refuses a link over 2048 characters", () => {
    expect(LinkUrl.safeParse(`https://a.test/${"x".repeat(2048)}`).success).toBe(false);
  });
  it("refuses a loopback lookalike host", () => {
    expect(LinkUrl.safeParse("http://127.0.0.1.evil.test/cb").success).toBe(false);
    expect(LinkUrl.safeParse("http://localhost.evil.test/cb").success).toBe(false);
  });
});

describe("LoginEvent", () => {
  it("accepts each kind and refuses unknown fields and kinds", () => {
    const ok = [
      { kind: "auth_url", url: "https://a.test/x", instructions: "Open it" },
      {
        kind: "device_code",
        userCode: "AB-12",
        verificationUri: "https://a.test/device",
        expiresInSeconds: 900,
      },
      { kind: "progress", message: "Waiting" },
      { kind: "info", message: "Hi", links: [{ url: "https://a.test/help", label: "Help" }] },
      { kind: "prompt", promptId: "p1", prompt: { type: "manual_code", message: "Paste the code" } },
      { kind: "done", ok: false, code: "timeout" },
    ];
    for (const event of ok) expect(LoginEvent.safeParse(event).success).toBe(true);
    expect(LoginEvent.safeParse({ kind: "progress", message: "x", extra: 1 }).success).toBe(false);
    expect(LoginEvent.safeParse({ kind: "snapshot", events: [] }).success).toBe(false);
    expect(LoginEvent.safeParse({ kind: "auth_url", url: "javascript:alert(1)" }).success).toBe(false);
    expect(LoginEvent.safeParse({ kind: "done", ok: false, code: "not_a_code" }).success).toBe(false);
  });
  it("clips nothing silently: a text over 2048 is refused, a select over 32 options is refused", () => {
    expect(LoginEvent.safeParse({ kind: "progress", message: "x".repeat(2049) }).success).toBe(false);
    const option = (i: number) => ({ id: `o${i}`, label: "L" });
    const select = (n: number) => ({
      type: "select",
      message: "Pick",
      options: Array.from({ length: n }, (_, i) => option(i)),
    });
    expect(LoginPrompt.safeParse(select(32)).success).toBe(true);
    expect(LoginPrompt.safeParse(select(33)).success).toBe(false);
    expect(LoginPrompt.safeParse(select(0)).success).toBe(false);
  });
});

describe("the login stream", () => {
  it("is a stream, and its snapshot holds at most 64 events", () => {
    expect(STREAMS).toContain("login");
    const event = { kind: "progress", message: "x" };
    expect(LoginStreamEvent.safeParse({ kind: "snapshot", events: [event] }).success).toBe(true);
    expect(
      LoginStreamEvent.safeParse({ kind: "snapshot", events: Array.from({ length: 65 }, () => event) })
        .success,
    ).toBe(false);
    expect(LoginStreamEvent.safeParse(event).success).toBe(true);
  });
});

describe("ApiKeyValue", () => {
  it("never accepts a key that Pi would run as a command, or a control character", () => {
    expect(ApiKeyValue.safeParse("!touch /tmp/x").success).toBe(false);
    expect(ApiKeyValue.safeParse("  !touch /tmp/x").success).toBe(false);
    expect(ApiKeyValue.safeParse("sk-a\nb").success).toBe(false);
    expect(ApiKeyValue.safeParse("sk-a\u0000b").success).toBe(false);
    expect(ApiKeyValue.safeParse("").success).toBe(false);
    expect(ApiKeyValue.safeParse("   ").success).toBe(false);
    expect(ApiKeyValue.safeParse("x".repeat(4097)).success).toBe(false);
    expect(ApiKeyValue.parse("  sk-ant-123  ")).toBe("sk-ant-123");
  });
});

describe("the sign-in methods (owner c3)", () => {
  const names = [
    "models.login",
    "models.loginAnswer",
    "models.loginCancel",
    "models.cancelLogin",
    "subscribe.login",
    "models.setApiKey",
    "models.logout",
  ] as const;
  it("are all pi:admin, and only the subscription is idempotent", () => {
    for (const name of names)
      expect(methods[name]).toMatchObject({ permission: "pi:admin", idempotent: name === "subscribe.login" });
  });
  it("declare step_up_required exactly on the two that add a credential", () => {
    for (const name of names)
      expect(methods[name].errors.includes("step_up_required" as never)).toBe(
        name === "models.login" || name === "models.setApiKey",
      );
  });
  it("bound the params and refuse unknown fields", () => {
    expect(methods["models.login"].params.safeParse({ provider: "anthropic", method: "oauth" }).success).toBe(
      true,
    );
    expect(methods["models.login"].params.safeParse({ provider: "anthropic", method: "x" }).success).toBe(
      false,
    );
    expect(
      methods["models.login"].params.safeParse({ provider: "anthropic", method: "oauth", cwd: "/x" }).success,
    ).toBe(false);
    expect(methods["models.setApiKey"].params.safeParse({ provider: "p", key: "!ls" }).success).toBe(false);
    expect(methods["models.setApiKey"].params.safeParse({ provider: "p", key: "k", cwd: "/x" }).success).toBe(
      false,
    );
    expect(
      methods["models.loginAnswer"].params.safeParse({ flowId: "f", promptId: "p1", value: "x".repeat(8193) })
        .success,
    ).toBe(false);
  });
  it("never put a secret in a result", () => {
    for (const name of [
      "models.loginAnswer",
      "models.loginCancel",
      "models.cancelLogin",
      "models.setApiKey",
      "models.logout",
    ] as const)
      expect(methods[name].result.parse({ ok: true, key: "sk" })).toEqual({ ok: true });
    expect(methods["models.login"].result.safeParse({ flowId: "f1" }).success).toBe(true);
  });
});

describe("helper operations and the hard-link message (R66)", () => {
  it("declares the three auth operations with strict params", () => {
    expect(HELPER_OPS["auth.login"].params.safeParse({ provider: "p", method: "oauth" }).success).toBe(true);
    expect(HELPER_OPS["auth.setApiKey"].params.safeParse({ provider: "p", key: "!ls" }).success).toBe(false);
    expect(HELPER_OPS["auth.logout"].params.safeParse({ provider: "p", extra: 1 }).success).toBe(false);
    expect(HELPER_OPS["auth.setApiKey"].result.safeParse({ ok: true, key: "sk" }).success).toBe(false);
  });
  it("gives a hard-linked file its own fixed code and message", () => {
    expect(helperErrorCode("config_hard_link")).toBe("config_hard_link");
    expect(ERROR_MESSAGES.config_hard_link).toBe(
      "Pi refused to write this file because it has another hard link. Replace it with a regular copy, then try again.",
    );
  });
  it("names the audit events", () => {
    expect(PROVIDER_AUDIT_REASONS).toEqual([
      "provider_signed_in",
      "provider_key_set",
      "provider_signed_out",
      "models_config_saved",
      "provider_discovered",
      "provider_saved",
      "provider_removed",
    ]);
  });
});

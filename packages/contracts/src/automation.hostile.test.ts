import { describe, expect, it } from "vitest";
import { AutomationSettings, TriggerInput } from "./automation.ts";

const base = {
  name: "Nightly review",
  source: { type: "manual" },
  execution: { cwd: "/home/owner/project" },
  prompt: "Review the changes.",
};
type Patch = Record<string, unknown>;
const ok = (patch: Patch = {}) => TriggerInput.safeParse({ ...base, ...patch }).success;
const withExecution = (execution: Patch, patch: Patch = {}) =>
  ok({ ...patch, execution: { ...base.execution, ...execution } });
const refused = (label: string, success: boolean) => expect(success, label).toBe(false);

describe("TriggerInput refuses", () => {
  it("an extra key anywhere", () => {
    refused("top", ok({ extra: 1 }));
    refused("source", ok({ source: { type: "manual", extra: 1 } }));
    refused("execution", withExecution({ extra: 1 }));
  });

  it("a mode with no sandbox, and a combined or missing webhook auth", () => {
    refused("full-access", withExecution({ mode: "full-access" }));
    refused("secret+hmac", ok({ source: { type: "webhook", auth: "secret+hmac" } }));
    refused("none", ok({ source: { type: "webhook", auth: "none" } }));
    refused("header", ok({ source: { type: "webhook", auth: "hmac", hmacHeader: "x-other" } }));
  });

  it("a relative folder and a folder with NUL", () => {
    refused("relative", withExecution({ cwd: "project" }));
    refused("nul", withExecution({ cwd: "/a\u0000b" }));
  });

  it("a bad tool list", () => {
    refused("empty", withExecution({ tools: [] }));
    refused("duplicate", withExecution({ tools: ["read", "read"] }));
    refused("flag", withExecution({ tools: ["-rf"] }));
    refused("space", withExecution({ tools: ["a b"] }));
    refused("33 tools", withExecution({ tools: Array.from({ length: 33 }, (_, i) => `t${i}`) }));
  });

  it("a precheck with a bidi control or a carriage return", () => {
    refused("bidi", withExecution({ precheck: "echo \u202e" }));
    refused("cr", withExecution({ precheck: "echo\rx" }));
  });

  it("run limits out of range", () => {
    refused("0 min", withExecution({ maxRunMinutes: 0 }));
    refused("241 min", withExecution({ maxRunMinutes: 241 }));
    refused("$0", withExecution({ maxRunUsd: 0 }));
  });

  it("an unknown or repeated placeholder", () => {
    refused("unknown", ok({ prompt: "{{secret}}" }));
    refused("two names", ok({ prompt: "{{ payload payload }}" }));
    refused("precheck without command", ok({ prompt: "{{precheck}}" }));
    refused("payload twice", ok({ prompt: "{{payload}} and {{payload}}" }));
    refused("payload twice, spaced", ok({ prompt: "{{payload}} ... {{ payload }}" }));
    refused("precheck twice", withExecution({ precheck: "true" }, { prompt: "{{precheck}}{{precheck}}" }));
  });

  it("variable names the shared child environment withholds, or malformed ones", () => {
    const names = [
      "PAP_HOME",
      "NODE_OPTIONS",
      "NOTIFY_SOCKET",
      "SSH_AUTH_SOCK",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "ANTHROPIC_API_KEY",
      "OPENAI_BASE_URL",
      "AWS_PROFILE",
      "AWS_REGION",
      "GIT_DIR",
      "LD_PRELOAD",
      "BASH_ENV",
      "PGPASSWORD",
      "MYSQL_PWD",
      "MY_SECRET",
      "x_api_key",
      "XDG_*",
      "1X",
      "A-B",
      "A B",
      "",
      "A".repeat(65),
      "K=V",
    ];
    for (const name of names) refused(name, withExecution({ precheck: "true", env: [name] }));
    refused("duplicate", withExecution({ precheck: "true", env: ["A", "A"] }));
    refused(
      "17 names",
      withExecution({ precheck: "true", env: Array.from({ length: 17 }, (_, i) => `V${i}`) }),
    );
    refused("no precheck", withExecution({ env: ["KUBECONFIG"] }));
  });

  it("a zero-width character in the prompt", () => {
    refused("zwsp", ok({ prompt: "review\u200bthis" }));
    refused("c1 control", ok({ prompt: "review\u0085this" }));
  });

  it("a bad name", () => {
    refused("newline", ok({ name: "a\nb" }));
    refused("81 chars", ok({ name: "x".repeat(81) }));
    refused("bidi", ok({ name: "\u202eevil" }));
  });

  it("a feed that is not a plain https address", () => {
    const feed = (url: string) => ok({ source: { type: "feed", url } });
    refused("http", feed("http://example.com/feed.xml"));
    refused("credentials", feed("https://user:pw@example.com/feed.xml"));
    refused("leading blank", feed(" https://example.com/feed.xml"));
    refused("javascript", feed("javascript:alert(1)"));
  });

  it("a bad schedule", () => {
    const schedule = (patch: Patch) =>
      ok({ source: { type: "schedule", rrule: "FREQ=DAILY", timezone: "Europe/Paris", ...patch } });
    refused("zone", schedule({ timezone: "Mars/Olympus" }));
    refused("lower case", schedule({ rrule: "freq=daily;byhour=2" }));
    refused("newline", schedule({ rrule: "FREQ=DAILY\nBYHOUR=2" }));
  });
});

describe("AutomationSettings refuses", () => {
  it("slots out of range, a 24:00 hour and an extra key", () => {
    refused("slots 9", AutomationSettings.safeParse({ slots: 9 }).success);
    refused("slots 0", AutomationSettings.safeParse({ slots: 0 }).success);
    refused("24:00", AutomationSettings.safeParse({ quietHours: { from: "24:00", to: "07:00" } }).success);
    refused("extra", AutomationSettings.safeParse({ extra: true }).success);
  });
});

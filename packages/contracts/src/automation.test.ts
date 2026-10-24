import { describe, expect, it } from "vitest";
import {
  AutomationSettings,
  inQuietHours,
  presetOfTools,
  TriggerInput,
  TriggerSaveInput,
  type TriggerInput as TriggerInputValue,
} from "./automation.ts";

const base = {
  name: "Nightly review",
  source: { type: "manual" },
  execution: { cwd: "/home/owner/project" },
  prompt: "Review the changes.",
};
const parse = (patch: Record<string, unknown> = {}): TriggerInputValue =>
  TriggerInput.parse({ ...base, ...patch });
const withSource = (source: Record<string, unknown>, execution: Record<string, unknown> = {}) =>
  parse({ source, execution: { ...base.execution, ...execution } });

describe("TriggerInput defaults", () => {
  it("fills the read tools, disabled, and the bounds", () => {
    const input = parse();
    expect(input.enabled).toBe(false);
    expect(input.execution).toMatchObject({
      tools: ["read", "grep", "find", "ls"],
      precheck: null,
      env: [],
      retryOnInterrupt: false,
      maxRunMinutes: 20,
      dailyBudgetUsd: null,
    });
  });

  it("defaults the webhook to a secret, ten minutes of dedup, and skipping resolved alerts", () => {
    expect(withSource({ type: "webhook" }).source).toMatchObject({
      auth: "secret",
      dedupMinutes: 10,
      format: "raw",
      onResolved: "skip",
      hmacHeader: "x-pap-signature-256",
    });
  });

  it("makes manual and schedule triggers auto-accept-edits with no cap", () => {
    const schedule = { type: "schedule", rrule: "FREQ=DAILY;BYHOUR=2;BYMINUTE=0", timezone: "Europe/Paris" };
    for (const source of [{ type: "manual" }, schedule]) {
      const input = withSource(source);
      expect(input.execution.mode).toBe("auto-accept-edits");
      expect(input.execution.maxRunUsd).toBeNull();
    }
  });

  it("makes webhook and feed triggers supervised with a $1 cap", () => {
    for (const source of [{ type: "webhook" }, { type: "feed", url: "https://example.com/feed.xml" }]) {
      const input = withSource(source);
      expect(input.execution.mode).toBe("supervised");
      expect(input.execution.maxRunUsd).toBe(1);
    }
  });

  it("keeps an explicit mode and an explicit null cap on a webhook trigger", () => {
    const input = withSource({ type: "webhook" }, { mode: "auto-accept-edits", maxRunUsd: null });
    expect(input.execution.mode).toBe("auto-accept-edits");
    expect(input.execution.maxRunUsd).toBeNull();
  });

  it("parses a stored value again to a deep-equal value", () => {
    for (const source of [{ type: "webhook" }, { type: "manual" }]) {
      const once = withSource(source);
      expect(TriggerInput.parse(once)).toEqual(once);
    }
  });
});

describe("TriggerInput accepted shapes", () => {
  it("parses the four sources", () => {
    expect(
      withSource({ type: "schedule", rrule: "FREQ=DAILY;BYHOUR=2;BYMINUTE=0", timezone: "Europe/Paris" })
        .source,
    ).toMatchObject({ catchUp: "skip" });
    expect(
      withSource({
        type: "schedule",
        rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9",
        timezone: "America/Argentina/Buenos_Aires",
      }).source.type,
    ).toBe("schedule");
    expect(withSource({ type: "feed", url: "https://example.com/feed.xml" }).source).toMatchObject({
      everyMinutes: 360,
    });
    expect(withSource({ type: "manual" }).source).toEqual({ type: "manual" });
  });

  it("takes an MCP tool name, a multi-line precheck with both placeholders, and precheck variable names", () => {
    const input = parse({
      execution: {
        cwd: "/srv/app",
        tools: ["read", "kubectl__get_pods"],
        precheck: "kubectl get pods\n\tgrep Error",
        env: ["KUBECONFIG", "DEPLOY_TARGET", "GH_HOST"],
      },
      prompt: "Pods: {{precheck}} and {{ payload }}",
    });
    expect(input.execution.env).toEqual(["KUBECONFIG", "DEPLOY_TARGET", "GH_HOST"]);
  });

  it("counts only payload and precheck: {{trigger}} twice parses", () => {
    expect(parse({ prompt: "{{trigger}} then {{trigger}} at {{firedAt}}" }).prompt).toContain("{{trigger}}");
  });

  it("takes an 80 code point name", () => {
    expect(parse({ name: "é".repeat(80) }).name).toHaveLength(80);
  });
});

describe("AutomationSettings", () => {
  it("defaults to the M10R5 values", () => {
    expect(AutomationSettings.parse({})).toEqual({
      paused: false,
      slots: 2,
      timezone: null,
      quietHours: null,
      dailyBudgetUsd: 5,
      autoResume: true,
    });
  });
});

describe("presetOfTools", () => {
  it("is read-only only when every tool is one of Pi's read tools", () => {
    expect(presetOfTools(["read", "grep"])).toBe("read-only");
    expect(presetOfTools(["read", "kubectl__apply"])).toBe("full");
    expect(presetOfTools(["read", "bash"])).toBe("full");
  });
});

describe("inQuietHours", () => {
  const night = { from: "22:30", to: "07:00" };
  const at = (iso: string) => Date.parse(iso);

  it("crosses midnight in the owner's zone", () => {
    // 2026-01-15 is winter time in Paris (UTC+1).
    expect(inQuietHours(night, "Europe/Paris", at("2026-01-15T22:00:00Z"))).toBe(true); // 23:00
    expect(inQuietHours(night, "Europe/Paris", at("2026-01-15T05:59:00Z"))).toBe(true); // 06:59
    expect(inQuietHours(night, "Europe/Paris", at("2026-01-15T06:00:00Z"))).toBe(false); // 07:00
    expect(inQuietHours(night, "Europe/Paris", at("2026-01-15T11:00:00Z"))).toBe(false); // 12:00
  });

  it("is no window when from equals to, and when there are no quiet hours", () => {
    expect(inQuietHours({ from: "08:00", to: "08:00" }, "UTC", at("2026-01-15T08:00:00Z"))).toBe(false);
    expect(inQuietHours(null, "UTC", at("2026-01-15T08:00:00Z"))).toBe(false);
  });

  it("reads the same instant in each zone", () => {
    const day = { from: "09:00", to: "17:00" };
    const instant = at("2026-01-15T01:00:00Z"); // 01:00 UTC, 10:00 in Tokyo
    expect(inQuietHours(day, "UTC", instant)).toBe(false);
    expect(inQuietHours(day, "Asia/Tokyo", instant)).toBe(true);
  });

  it("uses the local minute across a DST change", () => {
    const window = { from: "02:30", to: "03:30" };
    // 2026-03-29: Paris goes from UTC+1 to UTC+2 at 01:00 UTC.
    expect(inQuietHours(window, "Europe/Paris", at("2026-03-29T00:59:00Z"))).toBe(false); // 01:59
    expect(inQuietHours(window, "Europe/Paris", at("2026-03-29T01:00:00Z"))).toBe(true); // 03:00
    expect(inQuietHours(window, "Europe/Paris", at("2026-03-29T01:31:00Z"))).toBe(false); // 03:31
    // 2026-10-25: back to UTC+1 at 01:00 UTC (03:00 -> 02:00 local).
    expect(inQuietHours(window, "Europe/Paris", at("2026-10-25T00:45:00Z"))).toBe(true); // 02:45 CEST
    expect(inQuietHours(window, "Europe/Paris", at("2026-10-25T01:45:00Z"))).toBe(true); // 02:45 CET, the repeated hour
    expect(inQuietHours(window, "Europe/Paris", at("2026-10-25T02:31:00Z"))).toBe(false); // 03:31 CET
  });

  it("falls back to the server's zone when none is given", () => {
    expect(typeof inQuietHours(night, null, at("2026-01-15T22:00:00Z"))).toBe("boolean");
  });
});

describe("prechecks were removed (B6)", () => {
  const paths = (patch: Record<string, unknown>) => {
    const result = TriggerSaveInput.safeParse({ ...base, ...patch });
    return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
  };

  it("a stored precheck parses, a new one is refused", () => {
    const stored = { execution: { ...base.execution, precheck: "true", env: ["KUBECONFIG"] } };
    expect(parse(stored).execution).toMatchObject({ precheck: "true", env: ["KUBECONFIG"] });
    expect(paths(stored)).toEqual(expect.arrayContaining(["execution.precheck", "execution.env"]));
    expect(paths({})).toEqual([]);
  });

  it("{{precheck}} is refused on save", () => {
    const stored = { execution: { ...base.execution, precheck: "true" }, prompt: "Look: {{precheck}}" };
    expect(parse(stored).prompt).toBe("Look: {{precheck}}");
    expect(paths({ prompt: "Look: {{precheck}}" })).toContain("prompt");
    expect(paths(stored)).toContain("prompt");
  });
});

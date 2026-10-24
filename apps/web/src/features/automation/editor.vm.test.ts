import { ScheduleSource, type TriggerView } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import "../../i18n/register-automation.ts";
import "../../i18n/register-automation-trigger.ts";
import { translate } from "../../i18n/index.ts";
import {
  draftOf,
  effectiveMode,
  effectiveUsd,
  emptyDraft,
  fireNowEnabled,
  isDirty,
  rrulePreview,
  setTool,
  shownErrors,
  struckTools,
  toInput,
  toolNotes,
  toolProblem,
  type Draft,
} from "./editor.vm.ts";

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const draft = (over: Partial<Draft> = {}): Draft => ({
  ...emptyDraft("/work/atlas", "Europe/Paris"),
  name: "prod-alerts",
  prompt: "Investigate {{payload}}",
  ...over,
});
const words = (keys: readonly Parameters<typeof translate>[1][]) => keys.map((key) => translate("en", key));

describe("a new draft and its defaults", () => {
  it("starts as a schedule in the project folder and the browser's zone, auto-accepting edits with no dollar cap", () => {
    const blank = emptyDraft("/work/atlas", "Europe/Paris");
    expect(blank).toMatchObject({ sourceType: "schedule", cwd: "/work/atlas", timezone: "Europe/Paris" });
    expect(effectiveMode(blank)).toBe("auto-accept-edits");
    expect(effectiveUsd(blank)).toBe("");
  });

  it("a webhook or feed draft starts supervised with a $1 cap, as the contract's withDefaults makes it", () => {
    for (const sourceType of ["webhook", "feed"] as const) {
      const one = draft({ sourceType, feedUrl: "https://example.org/feed.xml" });
      expect(effectiveMode(one)).toBe("supervised");
      expect(effectiveUsd(one)).toBe("1");
      const parsed = toInput(one);
      expect(parsed.ok && parsed.input.execution.mode).toBe("supervised");
      expect(parsed.ok && parsed.input.execution.maxRunUsd).toBe(1);
    }
    const schedule = toInput(draft());
    expect(schedule.ok && schedule.input.execution.mode).toBe("auto-accept-edits");
    expect(schedule.ok && schedule.input.execution.maxRunUsd).toBeNull();
  });

  it("keeps an explicit choice and never clamps it: a webhook set to auto-accept-edits with no cap", () => {
    const parsed = toInput(draft({ sourceType: "webhook", mode: "auto-accept-edits", maxRunUsd: "" }));
    expect(parsed.ok && parsed.input.execution.mode).toBe("auto-accept-edits");
    expect(parsed.ok && parsed.input.execution.maxRunUsd).toBeNull();
    expect(effectiveMode(draft({ sourceType: "webhook", mode: "read-only" }))).toBe("read-only");
  });
});

describe("draft to TriggerInput", () => {
  it("turns each source into the contract's shape", () => {
    const webhook = toInput(
      draft({ sourceType: "webhook", auth: "hmac", format: "grafana", dedupMinutes: "30" }),
    );
    expect(webhook.ok && webhook.input.source).toMatchObject({
      type: "webhook",
      auth: "hmac",
      format: "grafana",
      dedupMinutes: 30,
    });
    const feed = toInput(
      draft({ sourceType: "feed", feedUrl: "https://example.org/feed.xml", feedEvery: "60" }),
    );
    expect(feed.ok && feed.input.source).toEqual({
      type: "feed",
      url: "https://example.org/feed.xml",
      everyMinutes: 60,
    });
    expect(toInput(draft({ sourceType: "manual" })).ok).toBe(true);
  });

  it("refuses with the contract's path and text", () => {
    const parsed = toInput(
      draft({ name: "", cwd: "relative", sourceType: "feed", feedUrl: "http://example.org" }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(Object.keys(parsed.errors)).toEqual(
      expect.arrayContaining(["name", "execution.cwd", "source.url"]),
    );
  });

  it("refuses {{precheck}} on the prompt, and a stored precheck on its own field, in pap's words (B6)", () => {
    const template = toInput(draft({ prompt: "Result: {{precheck}}", precheck: "" }));
    expect(!template.ok && template.errors["prompt"]).toBe(
      "Prechecks were removed: take {{precheck}} out of the prompt.",
    );
    const stored = toInput(draft({ precheck: "true", env: ["KUBECONFIG"] }));
    expect(!stored.ok && stored.errors["execution.precheck"]).toBe(
      "Prechecks were removed: clear this field.",
    );
    expect(toInput(draft({ precheck: "", env: [] })).ok).toBe(true);
  });

  it("hides an error on an empty field until the person tries, and shows it at once on a field with text", () => {
    const parsed = toInput(draft({ name: "", prompt: "{{precheck}}" }));
    if (parsed.ok) throw new Error("expected a refusal");
    const typed = draft({ name: "", prompt: "{{precheck}}" });
    expect(Object.keys(shownErrors(parsed.errors, typed, false))).toEqual(["prompt"]);
    expect(Object.keys(shownErrors(parsed.errors, typed, true)).sort()).toEqual(["name", "prompt"]);
  });
});

describe("unsaved changes", () => {
  const view = (over: Partial<TriggerView> = {}): TriggerView => {
    const saved = toInput(draft({ sourceType: "webhook" }));
    if (!saved.ok) throw new Error("fixture");
    return {
      id: "g1",
      name: saved.input.name,
      enabled: saved.input.enabled,
      state: "ok",
      source: saved.input.source,
      execution: saved.input.execution,
      prompt: saved.input.prompt,
      projectId: "p1",
      cwd: "/work/atlas",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      webhookUrl: "https://pap.home.arpa/hooks/g1",
      secretRotatedAt: NOW,
      nextFireAt: null,
      lastFireAt: null,
      redacted: false,
      ...over,
    };
  };

  it("reads a saved trigger back into the form it came from", () => {
    const baseline = draftOf(view(), emptyDraft("", "UTC"));
    expect(baseline).toMatchObject({
      sourceType: "webhook",
      name: "prod-alerts",
      mode: "supervised",
      maxRunUsd: "1",
    });
    expect(baseline && toInput(baseline).ok).toBe(true);
    expect(draftOf(view({ source: null }), emptyDraft("", "UTC"))).toBeNull();
  });

  it("sees a change and disables Fire now on it, and on a trigger that is not saved yet", () => {
    const baseline = draftOf(view(), emptyDraft("", "UTC")) as Draft;
    expect(isDirty(baseline, baseline)).toBe(false);
    expect(fireNowEnabled(baseline, baseline, "g1")).toBe(true);
    const edited = { ...baseline, prompt: `${baseline.prompt}!` };
    expect(isDirty(edited, baseline)).toBe(true);
    expect(fireNowEnabled(edited, baseline, "g1")).toBe(false);
    expect(fireNowEnabled(baseline, baseline, null)).toBe(false);
  });
});

describe("the tool list", () => {
  it("strikes through Pi's tools the list leaves out", () => {
    expect(struckTools(["read", "grep", "find", "ls"])).toEqual(["bash", "edit", "write"]);
    expect(struckTools(["read", "grep", "find", "ls", "bash", "edit", "write", "kubectl__get"])).toEqual([]);
  });

  it("adds and removes names, validated by ToolName", () => {
    expect(setTool(["read"], "kubectl__get", true)).toEqual(["read", "kubectl__get"]);
    expect(setTool(["read", "bash"], "bash", false)).toEqual(["read"]);
    expect(toolProblem("bad name", [])).toBe("bad");
    expect(toolProblem("read", ["read"])).toBe("duplicate");
    expect(toolProblem("kubectl__get", ["read"])).toBeNull();
  });

  it("refuses a 33rd tool (the contract's cap)", () => {
    const tools = Array.from({ length: 32 }, (_, index) => `tool_${index}`);
    expect(toolProblem("one_more", tools)).toBe("limit");
    expect(toolProblem("one_more", tools.slice(1))).toBeNull();
  });

  it("says exactly what asks under the chosen mode, once bash, edit or write is listed", () => {
    const tools = ["read", "bash"];
    expect(words(toolNotes("read-only", tools))).toEqual([
      "Blocked: this mode never runs them",
      "The read-only preset is off: calls follow the approval mode",
    ]);
    expect(words(toolNotes("supervised", tools))[0]).toBe(
      "Each call asks you (Inbox); unanswered after 10 minutes, it is denied",
    );
    expect(words(toolNotes("auto-accept-edits", tools))[0]).toBe(
      "edit and write inside the folder run without asking; bash asks you (Inbox)",
    );
    expect(toolNotes("supervised", ["read", "grep"])).toEqual([]);
  });

  it("shows the preset note for a name other than read grep find ls, and only then", () => {
    expect(words(toolNotes("supervised", ["read", "kubectl__apply"]))).toEqual([
      "The read-only preset is off: calls follow the approval mode",
    ]);
  });
});

describe("the schedule preview", () => {
  it("lists the next five fires of a daily rule in the trigger's zone", () => {
    const preview = rrulePreview("FREQ=DAILY;BYHOUR=9;BYMINUTE=0", "Europe/Paris", NOW);
    expect(preview.ok && preview.times).toHaveLength(5);
    expect(preview.ok && preview.times[0]).toBe(Date.UTC(2026, 9, 16, 7, 0, 0));
  });

  it("gives the contract's refusal for a weekly rule without BYHOUR", () => {
    const contract = ScheduleSource.safeParse({
      type: "schedule",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      timezone: "UTC",
    });
    const message = contract.success ? "" : (contract.error.issues[0]?.message ?? "");
    expect(message).not.toBe("");
    expect(rrulePreview("FREQ=WEEKLY;BYDAY=MO", "UTC", NOW)).toEqual({
      ok: false,
      message,
      missing: "BYHOUR",
    });
    expect(rrulePreview("FREQ=WEEKLY;BYDAY=MO;BYHOUR=9", "UTC", NOW).ok).toBe(true);
  });

  it("refuses an unknown zone with the contract's text", () => {
    expect(rrulePreview("FREQ=HOURLY", "Nowhere/Land", NOW).ok).toBe(false);
  });
});

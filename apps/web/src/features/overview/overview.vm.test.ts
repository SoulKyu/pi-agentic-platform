import { describe, expect, it } from "vitest";
import { translate, type MessageKey } from "../../i18n/index.ts";
import "../../i18n/register-overview.ts";
import { activityLine, askWords, formatGb, memoryText, nextRunText, percentText } from "./overview.vm.ts";
import { NOW, box } from "./overview-fixtures.ts";

const en = (key: MessageKey, vars?: Record<string, string | number>) => translate("en", key, vars);
const fr = (key: MessageKey, vars?: Record<string, string | number>) => translate("fr", key, vars);

/** The expected 24 h clock text of an instant, in the host's zone (what the formatter must print). */
const clock = (at: number) => {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

describe("overview.vm", () => {
  it("GB is MB / 1024 with one decimal and the locale's separator", () => {
    expect(formatGb(8192, "en")).toBe("8.0");
    expect(formatGb(10240, "fr")).toBe("10,0");
    expect(formatGb(1536, "en")).toBe("1.5");
    expect(memoryText(8192, 10240, "en", en)).toBe("8.0 / 10.0 GB");
    expect(memoryText(8192, 10240, "fr", fr)).toBe("8,0 / 10,0 Go");
  });

  it("a percentage keeps its locale form", () => {
    expect(percentText(80, en)).toBe("80%");
    expect(percentText(80, fr)).toBe("80 %");
  });

  it("an activity line is kind, title, a fixed 24 h time of day; an empty title drops its segment", () => {
    const since = NOW - 5 * 60_000;
    const time = clock(since);
    expect(activityLine({ kind: "task", id: "t", title: "Tidy", since, stoppable: true }, "en", en)).toBe(
      `Task · Tidy · since ${time}`,
    );
    expect(activityLine({ kind: "thread", id: "s", title: "", since, stoppable: false }, "fr", fr)).toBe(
      `Thread · depuis ${time}`,
    );
    expect(
      activityLine({ kind: "session", id: "s", title: "Fix", since: null, stoppable: false }, "en", en),
    ).toBe("Session · Fix");
  });

  it("a time of day is HH:MM in 24 h in every locale", () => {
    const afternoon = new Date(2026, 10, 3, 14, 5).getTime();
    expect(
      activityLine({ kind: "task", id: "t", title: "", since: afternoon, stoppable: true }, "en", en),
    ).toBe("Task · since 14:05");
    expect(
      activityLine({ kind: "task", id: "t", title: "", since: afternoon, stoppable: true }, "fr", fr),
    ).toBe("Tâche · depuis 14:05");
    const midnight = new Date(2026, 10, 3, 0, 7).getTime();
    expect(nextRunText(midnight, midnight, "en", en)).toBe("00:07");
  });

  it("the next run says tomorrow, or just the time today", () => {
    const today = Date.UTC(2026, 10, 3, 14, 30);
    const tomorrow = Date.UTC(2026, 10, 4, 8, 0);
    expect(nextRunText(today, NOW, "en", en)).toMatch(/^\d{2}:\d{2}$/);
    expect(nextRunText(tomorrow, NOW, "en", en)).toMatch(/^tomorrow \d{2}:\d{2}$/);
    expect(nextRunText(tomorrow, NOW, "fr", fr)).toMatch(/^demain \d{2}:\d{2}$/);
    const week = new Date(2026, 10, 9, 7, 0).getTime();
    expect(nextRunText(week, new Date(2026, 10, 3, 12).getTime(), "en", en)).toBe("Mon 07:00");
  });

  it("an ask shows its category word and its detail", () => {
    const item = {
      id: "i1",
      kind: "agent_approve",
      toHandle: true,
      taskId: null,
      sessionId: null,
      triggerName: "Nightly",
      costUsd: null,
      createdAt: 1,
      readAt: null,
      resolvedAt: null,
      resolution: null,
      agentId: null,
      refId: null,
      entryId: null,
      detail: null,
    } as const;
    expect(askWords({ source: "inbox", item }, en)).toEqual({ category: "Approval", detail: "Nightly" });
    expect(askWords({ source: "inbox", item: { ...item, detail: "Run rm" } }, en).detail).toBe("Run rm");
    expect(askWords({ source: "session", sessionId: "s", title: "Fix bug" }, en)).toEqual({
      category: "Waiting in this session",
      detail: "Fix bug",
    });
    expect(box().ask).toBeNull();
  });
});

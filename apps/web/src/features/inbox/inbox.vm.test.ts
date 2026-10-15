import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { itemOf, NOW } from "./inbox-bed.tsx";
import { chipOf, costOf, FILTERS, isOpen, ordered, titleOf, visible } from "./inbox.vm.ts";

afterEach(() => setLocale("en"));

const handled = itemOf({ id: "q1", resolvedAt: NOW, resolution: "answered" });
const info = itemOf({ id: "d1", kind: "task_done", toHandle: false, createdAt: NOW - 60_000 });
const older = itemOf({ id: "q2", createdAt: NOW - 600_000 });
const newer = itemOf({ id: "q3", createdAt: NOW - 120_000 });

describe("the filters", () => {
  it("offers All, To handle and Tasks, and no Replies before M11", () => {
    expect(FILTERS).toEqual(["all", "handle", "tasks"]);
  });

  it("keeps every item for All, only the open questions for To handle, and only task items for Tasks", () => {
    const reply = itemOf({ id: "r1", kind: "reply", toHandle: false });
    const all = [handled, info, older, reply];
    expect(visible(all, "all").map((item) => item.id)).toEqual(["q2", "d1", "r1", "q1"]);
    expect(visible(all, "handle").map((item) => item.id)).toEqual(["q2"]);
    expect(visible(all, "tasks").map((item) => item.id)).not.toContain("r1");
    expect(visible(all, "tasks")).toHaveLength(3);
  });

  it("counts a question as open only while it is to handle and unresolved", () => {
    expect(isOpen(older)).toBe(true);
    expect(isOpen(handled)).toBe(false);
    expect(isOpen(info)).toBe(false);
  });
});

describe("the order", () => {
  it("puts the rows to handle first, then newest first, and the id breaks a tie", () => {
    const tie = itemOf({ id: "z9", kind: "task_done", toHandle: false, createdAt: info.createdAt });
    expect(ordered([info, handled, older, tie, newer]).map((item) => item.id)).toEqual([
      "q3",
      "q2",
      "z9",
      "d1",
      "q1",
    ]);
  });

  it("does not change the list it is given", () => {
    const list = [older, newer];
    ordered(list);
    expect(list.map((item) => item.id)).toEqual(["q2", "q3"]);
  });
});

describe("the title per kind", () => {
  const cases: ReadonlyArray<[Partial<ReturnType<typeof itemOf>>, string, string]> = [
    [{}, "prod-alerts · waiting for your reply", "prod-alerts · attend ta réponse"],
    [{ kind: "task_done", toHandle: false }, "prod-alerts · finished", "prod-alerts · terminée"],
    [{ kind: "task_failed", toHandle: false }, "prod-alerts · failed", "prod-alerts · échec"],
    [{ kind: "task_interrupted", toHandle: false }, "prod-alerts · interrupted", "prod-alerts · interrompue"],
    [
      { kind: "task_limited", toHandle: false },
      "prod-alerts · limit reached",
      "prod-alerts · limite atteinte",
    ],
    [
      { resolvedAt: NOW, resolution: "timed_out" },
      "prod-alerts · refused (no answer)",
      "prod-alerts · refusé (pas de réponse)",
    ],
    [{ resolvedAt: NOW, resolution: "answered" }, "prod-alerts · answered", "prod-alerts · répondu"],
    [{ resolvedAt: NOW, resolution: null }, "prod-alerts · question closed", "prod-alerts · question fermée"],
    [{ kind: "reply", toHandle: false }, "prod-alerts · update", "prod-alerts · mise à jour"],
  ];
  it.each(cases)("%j reads the same in English and French", (patch, en, fr) => {
    expect(titleOf(itemOf(patch))).toBe(en);
    setLocale("fr");
    expect(titleOf(itemOf(patch))).toBe(fr);
  });

  it("writes a hidden character of the trigger name out and cuts a long one", () => {
    expect(titleOf(itemOf({ triggerName: "evil‮gnp" }))).toBe("evil\\u202Egnp · waiting for your reply");
    const long = titleOf(itemOf({ triggerName: "n".repeat(200) }));
    expect(long).toBe(`${"n".repeat(80)}… · waiting for your reply`);
  });
});

describe("the chip and the cost", () => {
  it("tints a question attention, a failure error and an unknown kind neutral", () => {
    expect(chipOf(older).tone).toBe("att");
    expect(chipOf(itemOf({ kind: "task_failed" })).tone).toBe("err");
    expect(chipOf(itemOf({ kind: "task_done" })).tone).toBe("ok");
    expect(chipOf(itemOf({ kind: "reply" }))).toEqual({ tone: "mut", label: "inbox.kind.other" });
  });

  it("formats the cost in dollars with two decimals, and says nothing without one", () => {
    expect(costOf(itemOf({ costUsd: 0.314 }))).toBe("$0.31");
    expect(costOf(itemOf({ costUsd: 0 }))).toBe("$0.00");
    expect(costOf(itemOf({ costUsd: null }))).toBeNull();
  });
});

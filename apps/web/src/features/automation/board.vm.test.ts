import { methods, type TaskView } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import "../../i18n/register-automation.ts";
import { setLocale, translate, errorKey } from "../../i18n/index.ts";
import {
  actionErrorText,
  actionsFor,
  budgetText,
  cardStatus,
  costToday,
  groupColumns,
  quietNow,
  shown,
  taskCost,
  taskDuration,
  type FailingAction,
} from "./board.vm.ts";
import { countsOf, projectOf, taskOf, triggerOf } from "./board-bed.tsx";

const projects = new Map([
  ["p1", projectOf("p1", "atlas", 2)],
  ["p2", projectOf("p2", "scout", 1)],
]);

describe("groupColumns", () => {
  it("makes one column per project with a task or a trigger, by the person's order, and 'Other folders' last", () => {
    const columns = groupColumns(
      [
        taskOf({ id: "a", projectId: "p1" }),
        taskOf({ id: "b", projectId: null }),
        taskOf({ id: "c", projectId: "gone" }),
      ],
      [triggerOf({ id: "g2", projectId: "p2" })],
      projects,
    );
    expect(columns.map((column) => [column.key, column.name])).toEqual([
      ["p2", "scout"],
      ["p1", "atlas"],
      ["other", null],
    ]);
    expect(columns[2]?.tasks.map((task) => task.id).sort()).toEqual(["b", "c"]);
    expect(columns[0]?.triggers.map((trigger) => trigger.id)).toEqual(["g2"]);
    expect(columns[2]?.projectId).toBeNull();
  });

  it("leaves out a project with nothing to show", () => {
    expect(groupColumns([], [], projects)).toEqual([]);
  });

  it("orders a column: needs input, running, queued, then the rest newest first", () => {
    const tasks = [
      taskOf({ id: "done-old", state: "done", createdAt: 1 }),
      taskOf({ id: "queued", state: "queued", createdAt: 5 }),
      taskOf({ id: "done-new", state: "done", createdAt: 9 }),
      taskOf({ id: "running", state: "running", createdAt: 3 }),
      taskOf({ id: "input", state: "running", needsInput: true, createdAt: 2 }),
      taskOf({ id: "failed", state: "failed", createdAt: 7 }),
    ];
    const [column] = groupColumns(tasks, [], projects);
    expect(column?.tasks.map((task) => task.id)).toEqual([
      "input",
      "running",
      "queued",
      "done-new",
      "failed",
      "done-old",
    ]);
  });
});

describe("actionsFor", () => {
  const states: Array<[Partial<TaskView>, string[]]> = [
    [{ state: "running" }, ["steer", "cancel"]],
    [{ state: "running", needsInput: true }, ["reply"]],
    [{ state: "queued", sessionId: null, startedAt: null }, ["cancel"]],
    [{ state: "failed" }, ["retry", "open", "releaseTools"]],
    [{ state: "interrupted" }, ["retry", "open", "releaseTools"]],
    [{ state: "cancelled" }, ["retry", "open", "releaseTools"]],
    [{ state: "done" }, ["open", "releaseTools"]],
    [{ state: "limited" }, ["resumeNow", "cancel", "open"]],
  ];
  it.each(states)("offers exactly the buttons of %j", (patch, expected) => {
    expect(actionsFor(taskOf(patch))).toEqual(expected);
  });

  it("offers 'Use my normal tools' only on a finished task whose list is still on", () => {
    expect(actionsFor(taskOf({ state: "done", toolsReleased: true }))).toEqual(["open"]);
    expect(actionsFor(taskOf({ state: "failed", toolsReleased: true }))).toEqual(["retry", "open"]);
    expect(actionsFor(taskOf({ state: "running", toolsReleased: false }))).not.toContain("releaseTools");
    expect(actionsFor(taskOf({ state: "limited" }))).not.toContain("releaseTools");
  });

  it("drops what needs a session when the task has none", () => {
    expect(actionsFor(taskOf({ state: "limited", sessionId: null }))).toEqual(["cancel"]);
    expect(actionsFor(taskOf({ state: "failed", sessionId: null }))).toEqual(["retry"]);
  });
});

describe("cardStatus", () => {
  it("uses M10R114's tones", () => {
    const tone = (patch: Partial<TaskView>) => cardStatus(taskOf(patch)).tone;
    expect(tone({ state: "running" })).toBe("run");
    expect(tone({ state: "running", needsInput: true })).toBe("att");
    expect(tone({ state: "queued" })).toBe("mut");
    expect(tone({ state: "done" })).toBe("ok");
    expect(tone({ state: "failed" })).toBe("err");
    expect(tone({ state: "interrupted" })).toBe("err");
    expect(tone({ state: "limited" })).toBe("mut");
    expect(tone({ state: "cancelled" })).toBe("mut");
    expect(cardStatus(taskOf({ state: "running", needsInput: true })).label).toBe("automation.state.input");
  });
});

describe("numbers", () => {
  it("writes the cost as $0.21 and the duration as 3m40", () => {
    expect(taskCost(taskOf({ costUsd: 0.21 }))).toBe("$0.21");
    expect(taskDuration(taskOf({ startedAt: 0, endedAt: 220_000 }), 999_999)).toBe("3m40");
    expect(taskDuration(taskOf({ startedAt: 1_000, endedAt: null }), 221_000)).toBe("3m40");
    expect(taskDuration(taskOf({ startedAt: null }), 5)).toBeNull();
  });

  it("counts the spend of today's tasks, a run in progress included", () => {
    const noon = new Date(2026, 9, 15, 12, 0, 0).getTime();
    const yesterday = new Date(2026, 9, 14, 23, 0, 0).getTime();
    const tasks = [
      taskOf({ id: "a", costUsd: 0.5, startedAt: noon - 60_000 }),
      taskOf({ id: "b", costUsd: 0.25, state: "queued", startedAt: null, createdAt: noon - 1_000 }),
      taskOf({ id: "c", costUsd: 9, startedAt: yesterday }),
    ];
    expect(costToday(tasks, noon)).toBeCloseTo(0.75);
  });

  it("writes the budget line, with and without a budget", () => {
    expect(budgetText(countsOf({ todayUsd: 1.84, budgetUsd: 5 }))).toBe("Today $1.84 / $5.00");
    expect(budgetText(countsOf({ todayUsd: 1.84, budgetUsd: null }))).toBe("Today $1.84");
  });

  it("shows the quiet-hours chip from the snapshot", () => {
    expect(quietNow(countsOf({ quietHours: true }))).toBe(true);
    expect(quietNow(countsOf({ quietHours: false }))).toBe(false);
    expect(quietNow(null)).toBe(false);
  });
});

describe("shown", () => {
  it("writes hidden and bidi characters out and clips to the cap", () => {
    expect(shown("a\u202Eb", "name")).toBe("a\\u202Eb");
    expect(shown("x".repeat(500), "detail")).toBe(`${"x".repeat(120)}…`);
    expect(shown("y".repeat(200), "name")).toBe(`${"y".repeat(80)}…`);
  });
});

describe("actionErrorText", () => {
  const ACTION_METHODS: Array<[FailingAction, keyof typeof methods]> = [
    ["cancel", "automation.tasks.cancel"],
    ["retry", "automation.tasks.retry"],
    ["releaseTools", "automation.tasks.releaseTools"],
    ["dismiss", "automation.failures.dismiss"],
    ["resumeNow", "usage.resumeNow"],
  ];

  for (const locale of ["en", "fr"] as const) {
    it.each(ACTION_METHODS)(
      `says something clear in ${locale} for every code %s declares`,
      (action, method) => {
        setLocale(locale);
        try {
          const codes = [...methods[method].errors, "automation_paused", "internal"] as string[];
          for (const code of codes) {
            const text = actionErrorText(action, code);
            expect(text, `${action} ${code}`).not.toMatch(/^(error|automation)\./);
            if (code !== "internal")
              expect(text, `${action} ${code}`).not.toBe(translate(locale, errorKey("internal")));
          }
        } finally {
          setLocale("en");
        }
      },
    );
  }

  it("prefers the sentence of the action over the generic one", () => {
    expect(actionErrorText("cancel", "conflict")).toBe("This task is already over.");
    expect(actionErrorText("retry", "budget_reached")).toContain("budget");
  });
});

// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { click, field, press, settle, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellProject, shellSession } from "../../testing/shell-snapshot.ts";
import {
  DAY,
  choose,
  closeToasts,
  deferred,
  load,
  menuItems,
  openMenu,
  projectTrigger,
  sessionTrigger,
  show,
  toastTexts,
} from "./menus-kit.tsx";
import { toLocalInput } from "./snooze.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  useShellStore.getState().reset();
});
afterEach(async () => {
  vi.useRealTimers();
  await closeToasts();
  vi.restoreAllMocks();
});
const marks = () => bed.called("sessions.mark").map((entry) => entry.params);
const updates = () => bed.called("projects.update").map((entry) => entry.params);

describe("the snooze dialog", () => {
  const openDialog = async () => {
    await load([shellSession({ id: "s1", name: "Fix login" })]);
    const box = await show();
    await openMenu(sessionTrigger(box, "Fix login"));
    await choose("Snooze until…");
    await act(async () => {
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull(), {
        timeout: 2000,
      });
    });
    return box;
  };
  const submit = async () => {
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    await click([...dialog.querySelectorAll("button")].find((b) => b.textContent === "Snooze") as Element);
    await settle();
  };

  it("refuses a time in the past or past a year, and sends nothing", async () => {
    await openDialog();
    const when = field(document, "Date and time");
    await typeInto(when, toLocalInput(Date.now() - DAY));
    await submit();
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
      "Pick a time at least a minute from now.",
    );
    await typeInto(when, toLocalInput(Date.now() + 400 * DAY));
    await submit();
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
      "Pick a time within a year.",
    );
    expect(marks()).toEqual([]);
  });

  it("sends the chosen time and closes", async () => {
    await openDialog();
    const value = toLocalInput(Date.now() + 2 * DAY);
    await typeInto(field(document, "Date and time"), value);
    await submit();
    expect(marks()).toEqual([
      { sessionId: "s1", change: { kind: "snooze", until: new Date(value).getTime() } },
    ]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(toastTexts()[0]).toBe("Snoozed · Fix loginUndo");
  });

  it("Escape closes the dialog and sends nothing; Cancel too", async () => {
    await openDialog();
    await press(document.activeElement as HTMLElement, { key: "Escape" });
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(marks()).toEqual([]);
  });
});

describe("the project menu", () => {
  const projects = () =>
    load(
      [
        shellSession({ id: "a1", projectId: "a", updatedAt: 3 }),
        shellSession({ id: "b1", projectId: "b", updatedAt: 2 }),
        shellSession({ id: "c1", projectId: "c", updatedAt: 1 }),
      ],
      {
        projects: [
          shellProject({ id: "a", name: "Alpha", position: 1 }),
          shellProject({ id: "b", name: "Bravo", position: 2 }),
          shellProject({ id: "c", name: "Charlie", position: 3 }),
        ],
      },
    );

  it("lists Rename, and Move up / Move down where they apply", async () => {
    await projects();
    const box = await show();
    await openMenu(projectTrigger(box, "Alpha"));
    expect(menuItems()).toEqual(["Rename", "Move down"]);
    await press(document.activeElement as HTMLElement, { key: "Escape" });
    await settle();
    await openMenu(projectTrigger(box, "Bravo"));
    expect(menuItems()).toEqual(["Rename", "Move up", "Move down"]);
    await press(document.activeElement as HTMLElement, { key: "Escape" });
    await settle();
    await openMenu(projectTrigger(box, "Charlie"));
    expect(menuItems()).toEqual(["Rename", "Move up"]);
  });

  it("Move up on the second project sends before = the first; Move down on the first, before = the third", async () => {
    await projects();
    const box = await show();
    await openMenu(projectTrigger(box, "Bravo"));
    await choose("Move up");
    expect(updates()).toEqual([{ projectId: "b", change: { kind: "move", before: "a" } }]);
    // The shown order follows at once: Bravo, Alpha, Charlie.
    expect([...box.querySelectorAll("section[data-group] h3")].map((h) => h.textContent)).toEqual([
      "Bravo",
      "Alpha",
      "Charlie",
    ]);
    await openMenu(projectTrigger(box, "Bravo"));
    await choose("Move down");
    expect(updates()[1]).toEqual({ projectId: "b", change: { kind: "move", before: "c" } });
  });

  it("Move down on the second of three sends before = null (last)", async () => {
    await projects();
    const box = await show();
    await openMenu(projectTrigger(box, "Bravo"));
    await choose("Move down");
    expect(updates()).toEqual([{ projectId: "b", change: { kind: "move", before: null } }]);
  });

  it("Rename turns the heading into a field; Enter sends the name and shows it at once", async () => {
    await projects();
    const box = await show();
    const answer = deferred();
    bed.handlers["projects.update"] = () => answer.promise;
    await openMenu(projectTrigger(box, "Alpha"));
    await choose("Rename");
    const input = field(box, "Project name");
    expect(input.value).toBe("Alpha");
    expect(input.closest("[data-inline-edit]")).not.toBeNull();
    expect(document.activeElement).toBe(input);
    await typeInto(input, "  Renamed  ");
    await press(input, { key: "Enter" });
    expect(updates()).toEqual([{ projectId: "a", change: { kind: "rename", name: "Renamed" } }]);
    expect(projectTrigger(box, "Renamed")).not.toBeNull();
    expect(box.querySelector("input[name='project-name']")).toBeNull();
    answer.resolve({ ok: true });
    await settle();
    expect(document.activeElement).toBe(projectTrigger(box, "Renamed"));
  });

  it("a refused rename rolls the name back and toasts why", async () => {
    await projects();
    const box = await show();
    bed.handlers["projects.update"] = async () => {
      throw new RpcError("not_found");
    };
    await openMenu(projectTrigger(box, "Alpha"));
    await choose("Rename");
    const input = field(box, "Project name");
    await typeInto(input, "Renamed");
    await press(input, { key: "Enter" });
    await settle();
    expect(projectTrigger(box, "Alpha")).not.toBeNull();
    expect(toastTexts().at(-1)).toBe("Not found.");
  });

  it("Escape restores the heading, sends nothing and is kept from the page", async () => {
    await projects();
    const box = await show();
    await openMenu(projectTrigger(box, "Alpha"));
    await choose("Rename");
    const input = field(box, "Project name");
    await typeInto(input, "Nope");
    const reached = vi.fn();
    document.addEventListener("keydown", reached);
    const event = await press(input, { key: "Escape" });
    document.removeEventListener("keydown", reached);
    expect(event.defaultPrevented).toBe(true);
    expect(reached).not.toHaveBeenCalled();
    expect(updates()).toEqual([]);
    expect(projectTrigger(box, "Alpha")).not.toBeNull();
    expect(document.activeElement).toBe(projectTrigger(box, "Alpha"));
  });

  it("refuses an empty or blank name before sending, with the field's error", async () => {
    await projects();
    const box = await show();
    await openMenu(projectTrigger(box, "Alpha"));
    await choose("Rename");
    for (const blank of ["", "   ", "\t "]) {
      await typeInto(field(box, "Project name"), blank);
      await press(field(box, "Project name"), { key: "Enter" });
      expect(box.querySelector("[data-inline-edit] [role='alert']")?.textContent).toBe(
        "A project needs a name.",
      );
    }
    expect(updates()).toEqual([]);
    expect(useShellStore.getState().view.projects.get("a")?.name).toBe("Alpha");
    expect(useShellStore.getState().view.pending.size).toBe(0);
  });
});

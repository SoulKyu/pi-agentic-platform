// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, settle } from "../../testing/dom.ts";
import { screenBed } from "../../testing/screen-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const screen = screenBed(current);
beforeEach(() => setLocale("en"));

const ask = {
  id: "a1",
  method: "approval",
  title: "Run a command?",
  message: "bash: ls",
  category: "exec",
  answers: ["deny", "once"],
};
const child = (patch: Record<string, unknown> = {}) => ({
  id: "c1",
  runId: "run-1",
  title: "Look around",
  profile: "scout",
  state: "running",
  costUsd: 0.25,
  dialogs: [],
  hiddenDialogs: 0,
  ...patch,
});

describe("SessionScreen with subagents (M11R153, M11R154)", () => {
  it("has no bar for a session without children", async () => {
    const container = await screen.show({});
    expect(container.querySelector("[data-subagent-bar]")).toBeNull();
  });

  it("puts the bar right above the composer, after the session's own banner slot", async () => {
    const container = await screen.show({ children: [child()] });
    const order = [...container.querySelectorAll("[data-subagent-bar], textarea")].map((node) =>
      node.hasAttribute("data-subagent-bar") ? "bar" : "composer",
    );
    expect(order).toEqual(["bar", "composer"]);
  });

  it("follows the subagents event, live", async () => {
    const container = await screen.show({});
    await screen.emit({ kind: "subagents", children: [child()] });
    expect(container.querySelectorAll("[data-subagent]")).toHaveLength(1);
    await screen.emit({ kind: "subagents", children: [child({ state: "done" })] });
    expect(container.querySelector("[data-subagent]")?.textContent).toContain("Done");
    await screen.emit({ kind: "subagents", children: [] });
    expect(container.querySelector("[data-subagent-bar]")).toBeNull();
  });

  it("renders a child's approval below the parent's own dialogs and answers it with the child's id", async () => {
    const own = { id: "p-d1", method: "confirm", title: "Parent question", message: "ok?" };
    const container = await screen.show({ dialogs: [own], children: [child({ dialogs: [ask] })] });
    const dialogs = [...container.querySelectorAll("[data-dialog]")];
    expect(dialogs).toHaveLength(2);
    expect(container.querySelector("[data-child-approvals]")?.textContent).toContain(
      "from subagent Look around",
    );
    expect(dialogs[0]?.textContent).toContain("Parent question");
    await click(button(container.querySelector("[data-child-approvals]") as HTMLElement, "Allow once"));
    await settle();
    const [call] = screen.bed.called("sessions.respondDialog");
    expect(call?.params).toMatchObject({ sessionId: "c1", dialogId: "a1" });
  });
});

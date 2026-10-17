// @vitest-environment happy-dom
import type { ChildView, Dialog } from "@pap/contracts";
import { TooltipProvider } from "@pap/ui";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { button, click, hasButton, mount, settle, text, type Mounted } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import "./register-session-catalog.ts";
import "../../i18n/register-subagents.ts";
import { ChildApprovals } from "./ChildApprovals.tsx";
import { SubagentBar } from "./SubagentBar.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
const navigated = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: ReactNode }) =>
      createElement("a", { href: props.to }, props.children),
    useNavigate: () => (target: unknown) => {
      navigated.calls.push(target);
      return Promise.resolve();
    },
  };
});

let bed: ReturnType<typeof fakeRuntime>;
let page: Mounted | null = null;
beforeEach(() => {
  setLocale("en");
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  navigated.calls = [];
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

const child = (id: string, patch: Partial<ChildView> = {}): ChildView => ({
  id,
  runId: `run-${id}`,
  title: `Task ${id}`,
  profile: "scout",
  state: "running",
  costUsd: 0.5,
  dialogs: [],
  hiddenDialogs: 0,
  ...patch,
});
const show = async (children: readonly ChildView[]) => {
  page = await mount(
    <TooltipProvider>
      <SubagentBar sessionId="parent-1" subagents={children} />
    </TooltipProvider>,
  );
  await settle();
  return page.container;
};

describe("the subagent bar (M11R153)", () => {
  it("renders nothing for a session without children", async () => {
    const view = await show([]);
    expect(view.querySelector("[data-subagent-bar]")).toBeNull();
  });

  it("shows one chip per child: title, profile, state and cost", async () => {
    const view = await show([child("c1"), child("c2", { state: "done", profile: null, costUsd: 1.25 })]);
    const chips = [...view.querySelectorAll("[data-subagent]")];
    expect(chips).toHaveLength(2);
    expect(chips[0]?.textContent).toContain("Task c1");
    expect(chips[0]?.textContent).toContain("scout");
    expect(chips[0]?.textContent).toContain("Running");
    expect(chips[0]?.textContent).toContain("$0.50");
    expect(chips[1]?.textContent).toContain("Done");
    expect(chips[1]?.textContent).toContain("$1.25");
    expect(chips[1]?.textContent).not.toContain("scout");
  });

  it("collapses past three to a count that opens the list", async () => {
    const view = await show([child("c1"), child("c2"), child("c3"), child("c4")]);
    expect(view.querySelectorAll("[data-subagent]")).toHaveLength(0);
    const toggle = button(view, "4 subagents");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(view.querySelectorAll("[data-subagent]")).toHaveLength(4);
  });

  it("does not collapse three or fewer, and says one subagent in the singular", async () => {
    const three = await show([child("c1"), child("c2"), child("c3")]);
    expect(three.querySelectorAll("[data-subagent]")).toHaveLength(3);
    expect(hasButton(three, "3 subagents")).toBe(false);
    await page?.unmount();
    const one = await show([child("c1")]);
    expect(text(one)).toContain("1 subagent");
    expect(text(one)).not.toContain("1 subagents");
  });

  it("opens a child as a session tab", async () => {
    const view = await show([child("c1")]);
    await click(button(view, "Open Task c1"));
    expect(navigated.calls).toEqual([{ to: "/s/$sessionId", params: { sessionId: "c1" } }]);
  });

  it("stops a running child by its run id, once, under one command id", async () => {
    const view = await show([child("c1")]);
    await click(button(view, "Stop Task c1"));
    await click(button(view, "Stop Task c1"));
    await settle();
    const calls = bed.called("subagents.cancel");
    expect(calls.map((call) => call.params)).toEqual([{ runId: "run-c1" }]);
    expect(calls[0]?.options?.commandId).toMatch(/^bed-cmd-/);
  });

  it.each(["starting", "running"] as const)("offers Stop for a %s child", async (state) => {
    const view = await show([child("c1", { state })]);
    expect(hasButton(view, "Stop Task c1")).toBe(true);
  });

  it.each(["done", "failed", "cancelled", "interrupted"] as const)(
    "offers no Stop for a %s child, only Open",
    async (state) => {
      const view = await show([child("c1", { state })]);
      expect(hasButton(view, "Stop Task c1")).toBe(false);
      expect(hasButton(view, "Open Task c1")).toBe(true);
    },
  );

  it("says why Stop failed, in an alert, and lets the owner try again", async () => {
    bed.handlers["subagents.cancel"] = () => {
      throw new RpcError("not_found");
    };
    const view = await show([child("c1")]);
    await click(button(view, "Stop Task c1"));
    await settle();
    expect(view.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    bed.handlers["subagents.cancel"] = () => ({ ok: true });
    await click(button(view, "Stop Task c1"));
    await settle();
    expect(bed.called("subagents.cancel")).toHaveLength(2);
    expect(view.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows a title as plain text without hidden characters, clipped", async () => {
    const view = await show([child("c1", { title: `<b>x</b>\u202e${"y".repeat(400)}` })]);
    const chip = view.querySelector("[data-subagent]");
    expect(chip?.querySelector("b")).toBeNull();
    expect(chip?.textContent).toContain("<b>x</b>");
    expect(chip?.textContent).not.toContain("\u202e");
    expect(chip?.textContent?.length ?? 0).toBeLessThan(300);
  });

  it("speaks French with the vous register", async () => {
    setLocale("fr");
    const view = await show([child("c1", { state: "done" })]);
    expect(text(view)).toContain("Terminé");
    expect(hasButton(view, "Ouvrir Task c1")).toBe(true);
    expect(text(view)).toContain("1 sous-agent");
  });
});

describe("child approvals in the parent (M11R154)", () => {
  const ask: Dialog = {
    id: "a1",
    method: "approval",
    title: "Run a command?",
    message: "bash: ls",
    category: "exec",
    answers: ["deny", "once"],
  };
  const showApprovals = async (children: readonly ChildView[]) => {
    page = await mount(
      <TooltipProvider>
        <ChildApprovals subagents={children} />
      </TooltipProvider>,
    );
    await settle();
    return page.container;
  };

  it("renders nothing when no child waits", async () => {
    const view = await showApprovals([child("c1")]);
    expect(view.querySelector("[data-child-approvals]")).toBeNull();
  });

  it("labels each waiting child's dialogs 'from subagent <title>'", async () => {
    const view = await showApprovals([
      child("c1", { dialogs: [ask] }),
      child("c2"),
      child("c3", { title: "Other", dialogs: [{ ...ask, id: "a2" }] }),
    ]);
    const groups = [...view.querySelectorAll("[data-child-approvals] > section")];
    expect(groups.map((group) => group.querySelector("h3")?.textContent)).toEqual([
      "from subagent Task c1",
      "from subagent Other",
    ]);
    expect(view.querySelectorAll("[data-dialog]")).toHaveLength(2);
  });

  it("answers with the CHILD's session id and the dialog's own id", async () => {
    const view = await showApprovals([child("c1", { dialogs: [ask] })]);
    await click(button(view, "Allow once"));
    await settle();
    const [call] = bed.called("sessions.respondDialog");
    expect(call?.params).toMatchObject({ sessionId: "c1", dialogId: "a1" });
    expect(call?.params).not.toMatchObject({ sessionId: "parent-1" });
  });

  it("cleans the label: no hidden characters, clipped", async () => {
    const view = await showApprovals([
      child("c1", { title: `A\u202eB\u200b${"z".repeat(300)}`, dialogs: [ask] }),
    ]);
    const label = view.querySelector("h3")?.textContent ?? "";
    expect(label.startsWith("from subagent AB")).toBe(true);
    expect(label).not.toMatch(/[\u202e\u200b]/);
    expect(label.length).toBeLessThan(200);
  });

  it("says how many more of a child's dialogs are waiting that the event could not carry", async () => {
    const view = await showApprovals([child("c1", { dialogs: [ask], hiddenDialogs: 2 })]);
    expect(text(view)).toContain("2 more dialogs are waiting");
  });

  it("shows a child whose dialogs were all cut with its count alone", async () => {
    const view = await showApprovals([child("c1", { dialogs: [], hiddenDialogs: 1 })]);
    expect(view.querySelector("h3")?.textContent).toBe("from subagent Task c1");
    expect(text(view)).toContain("1 more dialog is waiting");
  });
});

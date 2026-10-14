// @vitest-environment happy-dom
import type { SessionPolicyView } from "@pap/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { alerts, button, click, hasButton, mount, press, settle, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { SessionPolicy } from "./SessionPolicy.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; params?: { section: string }; children: ReactNode }) =>
      createElement("a", { href: props.to.replace("$section", props.params?.section ?? "") }, props.children),
  };
});

let bed: ReturnType<typeof fakeRuntime>;
const policy = (patch: Partial<SessionPolicyView> = {}): SessionPolicyView => ({
  mode: "auto-accept-edits",
  explicit: false,
  tainted: false,
  defaultMode: "auto-accept-edits",
  ...patch,
});
const show = (view: SessionPolicyView) => mount(<SessionPolicy sessionId="s1" policy={view} />);
const trigger = () => document.querySelector('[role="combobox"]') as HTMLElement;
const options = () => [...document.querySelectorAll('[role="option"]')].map((one) => one.textContent);

async function choose(label: string) {
  await act(async () => {
    trigger().dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
    );
  });
  await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull(), {
    timeout: 2_000,
  });
  const option = [...document.querySelectorAll('[role="option"]')].find((one) => one.textContent === label);
  await act(async () => {
    option?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }));
    (option as HTMLElement).click();
  });
  await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull(), { timeout: 2_000 });
  await settle();
}
const sent = (method: string) => bed.called(method).map((call) => [call.params, call.options]);

beforeEach(() => {
  setLocale("en");
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});
afterEach(() => setLocale("en"));

describe("SessionPolicy", () => {
  it("shows the mode and the taint from the view, and asks before full access and before clearing", async () => {
    const page = await show(policy({ tainted: true }));
    expect(text(page.container)).toContain("External content");
    await choose("Full access");
    expect(bed.called("policy.setSessionMode")).toEqual([]);
    expect(text(page.container)).toContain("A shell command is limited only by the blocked-command list");
    await click(button(page.container, "Switch"));
    await settle();
    expect(sent("policy.setSessionMode")).toEqual([
      [{ sessionId: "s1", mode: "full-access" }, { commandId: "bed-cmd-00000001" }],
    ]);
    expect(text(page.container)).toContain("Approval mode saved.");
    await click(button(page.container, "Clear"));
    expect(bed.called("policy.clearTaint")).toEqual([]);
    expect(text(page.container)).toContain("Only clear this if you checked what the agent read.");
    await click(button(page.container, "Clear"));
    await settle();
    expect(sent("policy.clearTaint")).toEqual([[{ sessionId: "s1" }, { commandId: "bed-cmd-00000002" }]]);
    expect(text(page.container)).toContain("External content cleared.");
  });

  it("lists the four modes and the default with its mode, and shows no chip when nothing is tainted", async () => {
    const page = await show(policy());
    expect(text(page.container)).not.toContain("External content");
    expect(trigger().textContent).toContain("Use my default (Auto-accept edits)");
    await act(async () => {
      trigger().dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
      );
    });
    await vi.waitFor(() => expect(options()).toHaveLength(5), { timeout: 2_000 });
    expect(options()).toEqual([
      "Use my default (Auto-accept edits)",
      "Read only",
      "Ask for everything",
      "Auto-accept edits",
      "Full access",
    ]);
  });

  it("names the owner's default mode when the session follows it (M7R123)", async () => {
    await show(policy({ mode: "supervised", defaultMode: "supervised" }));
    expect(trigger().textContent).toContain("Use my default (Ask for everything)");
  });

  it("names the owner's default mode in the list even when the session chose its own", async () => {
    await show(policy({ mode: "read-only", explicit: true, defaultMode: "supervised" }));
    expect(trigger().textContent).toContain("Read only");
    await act(async () => {
      trigger().dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
      );
    });
    await vi.waitFor(() => expect(options()).toHaveLength(5), { timeout: 2_000 });
    expect(options()[0]).toBe("Use my default (Ask for everything)");
  });

  it("sends a mode other than full access straight away, and null for the default", async () => {
    const page = await show(policy({ mode: "supervised", explicit: true }));
    expect(trigger().textContent).toContain("Ask for everything");
    await choose("Read only");
    await choose("Use my default (Auto-accept edits)");
    expect(sent("policy.setSessionMode")).toEqual([
      [{ sessionId: "s1", mode: "read-only" }, { commandId: "bed-cmd-00000001" }],
      [{ sessionId: "s1", mode: null }, { commandId: "bed-cmd-00000002" }],
    ]);
    expect(hasButton(page.container, "Switch")).toBe(false);
  });

  it("cancelling the full access question sends nothing and puts the focus back on the selector", async () => {
    const page = await show(policy());
    await choose("Full access");
    await click(button(page.container, "Cancel"));
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger()), { timeout: 2_000 });
    expect(hasButton(page.container, "Switch")).toBe(false);
    expect(bed.called("policy.setSessionMode")).toEqual([]);
  });

  it("Escape in a question cancels it and never reaches the page's own Escape (it must not stop the run)", async () => {
    const onDocument = vi.fn();
    document.addEventListener("keydown", onDocument);
    try {
      const page = await show(policy({ tainted: true }));
      await click(button(page.container, "Clear"));
      const confirm = button(page.container, "Clear");
      await press(confirm, { key: "Escape" });
      expect(onDocument).not.toHaveBeenCalled();
      expect(text(page.container)).not.toContain("Only clear this");
      expect(bed.called("policy.clearTaint")).toEqual([]);
      expect(page.container.querySelector("[data-inline-edit]")).toBeNull();
    } finally {
      document.removeEventListener("keydown", onDocument);
    }
  });

  it("marks the whole bar as an edit in progress while a question is open, so Escape from any control spares the run", async () => {
    const page = await show(policy({ tainted: true }));
    expect(page.container.querySelector("[data-session-policy][data-inline-edit]")).toBeNull();
    await click(button(page.container, "Clear"));
    expect(page.container.querySelector("[data-session-policy][data-inline-edit]")).not.toBeNull();
    expect(trigger().closest("[data-inline-edit]")).not.toBeNull();
  });

  it("does not bring the Clear question back when the taint returns after a clear", async () => {
    const page = await show(policy({ tainted: true }));
    await click(button(page.container, "Clear"));
    expect(text(page.container)).toContain("Only clear this");
    await page.rerender(<SessionPolicy sessionId="s1" policy={policy({ tainted: false })} />);
    await page.rerender(<SessionPolicy sessionId="s1" policy={policy({ tainted: true })} />);
    expect(text(page.container)).not.toContain("Only clear this");
    expect(hasButton(page.container, "Clear")).toBe(true);
  });

  it("answers the confirm once when it is clicked twice", async () => {
    const page = await show(policy({ tainted: true }));
    await click(button(page.container, "Clear"));
    const confirm = button(page.container, "Clear");
    await click(confirm);
    await click(confirm);
    await settle();
    expect(bed.called("policy.clearTaint")).toHaveLength(1);
  });

  it("shows a failed mode change and a failed Clear, and an unknown outcome is not retried", async () => {
    bed.handlers["policy.setSessionMode"] = () => {
      throw new RpcError("not_found");
    };
    bed.handlers["policy.clearTaint"] = () => {
      throw new RpcError("timeout");
    };
    const page = await show(policy({ tainted: true }));
    await choose("Read only");
    expect(alerts(page.container)).toEqual(["Not found."]);
    expect(text(page.container)).not.toContain("Approval mode saved.");
    await click(button(page.container, "Clear"));
    await click(button(page.container, "Clear"));
    await settle();
    expect(alerts(page.container)).toHaveLength(1);
    expect(alerts(page.container)[0]).not.toBe("Not found.");
    expect(text(page.container)).not.toContain("External content cleared.");
    expect(bed.called("policy.clearTaint")).toHaveLength(1);
  });

  it("links to Settings > Approvals and warns about the shell in the full access question", async () => {
    const page = await show(policy());
    const link = [...page.container.querySelectorAll("a")].find(
      (one) => one.textContent === "Manage approvals",
    );
    expect(link?.getAttribute("href")).toBe("/settings/approvals");
    await choose("Full access");
    expect(text(page.container)).toContain(
      "Run calls without asking? Blocked commands stay blocked. Writes outside the project or to protected files, reads of pap's own secrets and, after external content, every command and external tool still ask. A shell command is limited only by the blocked-command list.",
    );
  });

  it("speaks French", async () => {
    setLocale("fr");
    const page = await show(policy({ tainted: true }));
    expect(text(page.container)).toContain("Contenu externe");
    expect(text(page.container)).toContain("Gérer les approbations");
  });
});

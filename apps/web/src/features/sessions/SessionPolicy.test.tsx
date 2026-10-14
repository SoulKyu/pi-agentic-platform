// @vitest-environment happy-dom
// The session chunk registers these strings when it loads; the component is rendered here without it.
import "./register-session-catalog.ts";
import type { SessionPolicyView } from "@pap/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { alerts, button, click, hasButton, mount, press, settle, text } from "../../testing/dom.ts";
import { menuItem, menuLabels, openMenu, pickItem, preloadMenu } from "../../testing/menu.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { SessionPolicy } from "./SessionPolicy.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined, navigate: vi.fn() }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => current.navigate }));

let bed: ReturnType<typeof fakeRuntime>;
const policy = (patch: Partial<SessionPolicyView> = {}): SessionPolicyView => ({
  mode: "auto-accept-edits",
  explicit: false,
  tainted: false,
  defaultMode: "auto-accept-edits",
  ...patch,
});
const element = (view: SessionPolicyView) => (
  <SessionPolicy sessionId="s1" policy={view} cwd="/work/project" />
);
const show = (view: SessionPolicyView) => mount(element(view));
const chip = () => document.querySelector("[data-policy-mode]") as HTMLElement;
const pick = (label: string) => pickItem(chip(), label);
const sent = (method: string) => bed.called(method).map((call) => [call.params, call.options]);

beforeAll(preloadMenu);
beforeEach(() => {
  setLocale("en");
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  current.navigate.mockReset();
});
afterEach(() => setLocale("en"));

describe("SessionPolicy chip", () => {
  it("is one button that names the mode, in its text and in its accessible name", async () => {
    await show(policy({ mode: "supervised", explicit: true }));
    expect(chip().tagName).toBe("BUTTON");
    expect(chip().textContent).toBe("Ask for everything");
    expect(chip().getAttribute("aria-label")).toBe("Approval mode: Ask for everything");
  });

  it("says when the mode is the owner's default (M7R123)", async () => {
    await show(policy({ mode: "supervised", defaultMode: "supervised" }));
    expect(chip().getAttribute("aria-label")).toBe("Approval mode: Ask for everything (your default)");
  });

  it("keeps the external-content state visible next to the chip, with its reason for a screen reader", async () => {
    const page = await show(policy());
    expect(text(page.container)).not.toContain("External content");
    await page.rerender(element(policy({ tainted: true })));
    expect(text(page.container)).toContain("External content");
    const why = document.getElementById(chip().getAttribute("aria-describedby") ?? "");
    expect(why?.textContent).toContain("Calls that could leak data or write elsewhere now ask first.");
  });

  it("holds every former bar function in its menu: the modes, Clear, the always-rules, Manage approvals", async () => {
    await show(policy({ tainted: true }));
    await openMenu(chip());
    expect(document.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe(
      "Approvals for this session",
    );
    expect(menuLabels()).toEqual([
      "Use my default (Auto-accept edits) (current)",
      "Read only",
      "Ask for everything",
      "Auto-accept edits",
      "Full access",
      "Clear external content",
      "Always allowed in this project",
      "Manage approvals",
    ]);
  });

  it("offers Clear only while the session is tainted", async () => {
    await show(policy());
    await openMenu(chip());
    expect(menuLabels()).not.toContain("Clear external content");
  });

  it("marks the session's own choice as current, and names the default mode even then", async () => {
    await show(policy({ mode: "read-only", explicit: true, defaultMode: "supervised" }));
    await openMenu(chip());
    expect(menuLabels().slice(0, 2)).toEqual(["Use my default (Ask for everything)", "Read only (current)"]);
  });

  it("sends a mode other than full access straight away, and null for the default", async () => {
    const page = await show(policy({ mode: "supervised", explicit: true }));
    await pick("Read only");
    await pick("Use my default (Auto-accept edits)");
    expect(sent("policy.setSessionMode")).toEqual([
      [{ sessionId: "s1", mode: "read-only" }, { commandId: "bed-cmd-00000001" }],
      [{ sessionId: "s1", mode: null }, { commandId: "bed-cmd-00000002" }],
    ]);
    expect(hasButton(page.container, "Switch")).toBe(false);
    expect(text(page.container)).toContain("Approval mode saved.");
  });

  it("does not send the mode that is already current", async () => {
    await show(policy({ mode: "supervised", explicit: true }));
    await pick("Ask for everything (current)");
    expect(bed.called("policy.setSessionMode")).toEqual([]);
  });

  it("keeps Full access apart in the menu (danger tone)", async () => {
    await show(policy());
    await openMenu(chip());
    expect(menuItem("Full access").className).toContain("text-err");
    expect(menuItem("Read only").className).not.toContain("text-err");
  });
});

describe("SessionPolicy asks", () => {
  it("asks before full access and sends nothing until Switch", async () => {
    const page = await show(policy({ tainted: true }));
    await pick("Full access");
    expect(bed.called("policy.setSessionMode")).toEqual([]);
    expect(text(page.container)).toContain("A shell command is limited only by the blocked-command list");
    await click(button(page.container, "Switch"));
    await settle();
    expect(sent("policy.setSessionMode")).toEqual([
      [{ sessionId: "s1", mode: "full-access" }, { commandId: "bed-cmd-00000001" }],
    ]);
    expect(text(page.container)).toContain("Approval mode saved.");
  });

  it("warns about the shell in the full access question", async () => {
    const page = await show(policy());
    await pick("Full access");
    expect(text(page.container)).toContain(
      "Run calls without asking? Blocked commands stay blocked. Writes outside the project or to protected files, reads of pap's own secrets and, after external content, every command and external tool still ask. A shell command is limited only by the blocked-command list.",
    );
  });

  it("asks before clearing the taint, says why it matters, and sends nothing until Clear", async () => {
    const page = await show(policy({ tainted: true }));
    await pick("Clear external content");
    expect(bed.called("policy.clearTaint")).toEqual([]);
    expect(text(page.container)).toContain("Only clear this if you checked what the agent read.");
    expect(text(page.container)).toContain("Calls that could leak data or write elsewhere now ask first.");
    await click(button(page.container, "Clear"));
    await settle();
    expect(sent("policy.clearTaint")).toEqual([[{ sessionId: "s1" }, { commandId: "bed-cmd-00000001" }]]);
    expect(text(page.container)).toContain("External content cleared.");
  });

  it("cancelling the full access question sends nothing and puts the focus back on the chip", async () => {
    const page = await show(policy());
    await pick("Full access");
    await click(button(page.container, "Cancel"));
    await vi.waitFor(() => expect(document.activeElement).toBe(chip()), { timeout: 2_000 });
    expect(hasButton(page.container, "Switch")).toBe(false);
    expect(bed.called("policy.setSessionMode")).toEqual([]);
  });

  it("Escape in a question cancels it and never reaches the page's own Escape (it must not stop the run)", async () => {
    const onDocument = vi.fn();
    document.addEventListener("keydown", onDocument);
    try {
      const page = await show(policy({ tainted: true }));
      await pick("Clear external content");
      await press(button(page.container, "Clear"), { key: "Escape" });
      expect(onDocument).not.toHaveBeenCalled();
      expect(text(page.container)).not.toContain("Only clear this");
      expect(bed.called("policy.clearTaint")).toEqual([]);
      expect(page.container.querySelector("[data-inline-edit]")).toBeNull();
    } finally {
      document.removeEventListener("keydown", onDocument);
    }
  });

  it("marks the chip and the question as an edit in progress while one is open, so Escape from either spares the run", async () => {
    const page = await show(policy({ tainted: true }));
    expect(page.container.querySelector("[data-session-policy][data-inline-edit]")).toBeNull();
    await pick("Clear external content");
    expect(page.container.querySelector("[data-session-policy][data-inline-edit]")).not.toBeNull();
    expect(chip().closest("[data-inline-edit]")).not.toBeNull();
  });

  it("does not bring the Clear question back when the taint returns after a clear", async () => {
    const page = await show(policy({ tainted: true }));
    await pick("Clear external content");
    expect(text(page.container)).toContain("Only clear this");
    await page.rerender(element(policy({ tainted: false })));
    await page.rerender(element(policy({ tainted: true })));
    expect(text(page.container)).not.toContain("Only clear this");
  });

  it("answers the confirm once when it is clicked twice", async () => {
    const page = await show(policy({ tainted: true }));
    await pick("Clear external content");
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
    await pick("Read only");
    expect(alerts(page.container)).toEqual(["Not found."]);
    expect(text(page.container)).not.toContain("Approval mode saved.");
    await pick("Clear external content");
    await click(button(page.container, "Clear"));
    await settle();
    expect(alerts(page.container)).toHaveLength(1);
    expect(alerts(page.container)[0]).not.toBe("Not found.");
    expect(text(page.container)).not.toContain("External content cleared.");
    expect(bed.called("policy.clearTaint")).toHaveLength(1);
  });

  it("disables the chip while a mode change is in flight", async () => {
    let release: (value: unknown) => void = () => {};
    bed.handlers["policy.setSessionMode"] = () => new Promise((ok) => (release = ok));
    await show(policy());
    await pick("Read only");
    expect((chip() as HTMLButtonElement).disabled).toBe(true);
    release({});
    await settle();
    expect((chip() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("SessionPolicy links", () => {
  it("opens Settings > Approvals from the menu", async () => {
    await show(policy());
    await pick("Manage approvals");
    expect(current.navigate).toHaveBeenCalledWith({
      to: "/settings/$section",
      params: { section: "approvals" },
    });
  });

  it("speaks French", async () => {
    setLocale("fr");
    const page = await show(policy({ tainted: true }));
    expect(text(page.container)).toContain("Contenu externe");
    expect(chip().getAttribute("aria-label")).toBe(
      "Mode d'approbation : Modifications acceptées (votre mode par défaut)",
    );
    await openMenu(chip());
    expect(menuLabels()).toContain("Gérer les approbations");
    expect(menuLabels()).toContain("Effacer le contenu externe");
  });
});

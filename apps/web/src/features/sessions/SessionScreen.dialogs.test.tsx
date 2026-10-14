// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { setLocale } from "../../i18n/index.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { button, click, mount, settle, type Mounted } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { SessionScreen } from "./SessionScreen.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: ReactNode }) =>
      createElement("a", { href: props.to }, props.children),
    useNavigate: () => () => Promise.resolve(),
  };
});

let bed: ReturnType<typeof fakeRuntime>;
let page: Mounted | null = null;

const snapshot = (dialogs: unknown[], policy?: unknown) => ({
  ...(policy === undefined ? {} : { policy }),
  kind: "snapshot",
  status: "running",
  rows: [],
  dialogs,
  partial: null,
  queue: { steering: [], followUp: [], count: 0, bytes: 0 },
  statuses: [],
  widgets: [],
  title: null,
  panels: [],
  notices: [],
  decorationsTruncated: false,
  history: { hasMore: false, oldestEntryId: null, turnsBefore: 0 },
  activity: { compacting: false, retry: null },
  leafId: null,
  name: null,
});
const approval = {
  id: "a1",
  method: "approval",
  title: "Run a command?",
  message: "1 character, 1 line\nbash: ls",
  category: "exec",
  answers: ["deny", "once"],
};
const confirm = { id: "d1", method: "confirm", title: "Run a command?", message: "bash: ls" };

async function show(dialogs: unknown[], policy?: unknown) {
  page = await mount(<SessionScreen sessionId="sess-1" />);
  await settle();
  bed.emit(snapshot(dialogs, policy));
  await settle();
  return page.container;
}
const answers = () => bed.called("sessions.respondDialog").map((call) => call.params);

beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  useSessionStore.setState({ views: {} });
  setLocale("en");
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("SessionScreen approval dialogs", () => {
  it("renders an approval as an approval dialog with its category", async () => {
    const container = await show([approval]);
    const card = container.querySelector('[role="alertdialog"]');
    expect(card?.querySelector("h3")?.textContent).toBe("Approval·exec");
    expect(container.querySelector("[data-approval-scroll]")?.textContent).toBe("bash: ls");
  });

  it("answers Allow once with { answer: 'once' }, exactly once", async () => {
    const container = await show([approval]);
    await click(button(container, "Allow once"));
    await click(button(container, "Deny"));
    await settle();
    expect(answers()).toEqual([{ sessionId: "sess-1", dialogId: "a1", response: { answer: "once" } }]);
  });

  it("answers Deny with { answer: 'deny' }", async () => {
    const container = await show([approval]);
    await click(button(container, "Deny"));
    await settle();
    expect(answers()).toEqual([{ sessionId: "sess-1", dialogId: "a1", response: { answer: "deny" } }]);
  });

  it("answers an extension's confirm with { confirmed }, from a card that is not an approval", async () => {
    const container = await show([confirm]);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    await click(button(container, "Yes"));
    await settle();
    expect(answers()).toEqual([{ sessionId: "sess-1", dialogId: "d1", response: { confirmed: true } }]);
  });

  it("says a tainted approval is about external content, and a plain one does not", async () => {
    const container = await show([{ ...approval, tainted: true }]);
    expect(container.querySelector('[role="alertdialog"] h3')?.textContent).toBe(
      "Approval·exec · external content",
    );
    expect(container.querySelector('[role="alertdialog"]')?.getAttribute("aria-label")).toBe(
      "Approval exec · external content",
    );
  });

  it("keeps a plain approval's heading as it was", async () => {
    const container = await show([approval]);
    expect(container.querySelector('[role="alertdialog"] h3')?.textContent).toBe("Approval·exec");
  });

  it("says it in French", async () => {
    setLocale("fr");
    const container = await show([{ ...approval, tainted: true }]);
    expect(container.querySelector('[role="alertdialog"] h3')?.textContent).toContain(
      "exécution · contenu externe",
    );
  });

  it("shows one line under the question for the guard rule that asks", async () => {
    const lines = {
      "identical-calls": "The agent repeated the same call several times.",
      "tool-calls": "This run made many tool calls.",
      turns: "This run took many turns.",
    };
    for (const [guard, line] of Object.entries(lines)) {
      useSessionStore.setState({ views: {} });
      bed = fakeRuntime();
      current.runtime = bed.runtime;
      const container = await show([{ ...approval, guard }]);
      const shown = [...container.querySelectorAll("[data-approval-guard]")].map((one) => one.textContent);
      expect(shown).toEqual([line]);
      await page?.unmount();
    }
  });

  it("shows no guard line when the dialog has no guard rule", async () => {
    const container = await show([approval]);
    expect(container.querySelector("[data-approval-guard]")).toBeNull();
  });

  it("mounts the mode chip in the header from the snapshot's policy, and a policy event changes it", async () => {
    const container = await show([], { mode: "read-only", explicit: true, tainted: true });
    expect(container.querySelector("[data-session-policy]")?.textContent).toContain("External content");
    expect(container.querySelector("header [data-policy-mode]")?.textContent).toBe("Read only");
    expect(container.querySelector("section[data-session-policy]")).toBeNull();
    bed.emit({ kind: "policy", policy: { mode: "read-only", explicit: true, tainted: false } });
    await settle();
    expect(container.querySelector("[data-session-policy]")?.textContent).not.toContain("External content");
  });
});

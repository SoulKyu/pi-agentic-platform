// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
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
  };
});

let bed: ReturnType<typeof fakeRuntime>;
let page: Mounted | null = null;

const snapshot = (dialogs: unknown[]) => ({
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

async function show(dialogs: unknown[]) {
  page = await mount(<SessionScreen sessionId="sess-1" />);
  await settle();
  bed.emit(snapshot(dialogs));
  await settle();
  return page.container;
}
const answers = () => bed.called("sessions.respondDialog").map((call) => call.params);

beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  useSessionStore.setState({ views: {} });
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("SessionScreen approval dialogs", () => {
  it("renders an approval as an approval card", async () => {
    const container = await show([approval]);
    expect(container.querySelector('[role="alertdialog"]')?.getAttribute("aria-label")).toBe(
      "Approval needed",
    );
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

  it("still answers an extension's confirm with { confirmed }", async () => {
    const container = await show([confirm]);
    await click(button(container, "Allow once"));
    await settle();
    expect(answers()).toEqual([{ sessionId: "sess-1", dialogId: "d1", response: { confirmed: true } }]);
  });
});

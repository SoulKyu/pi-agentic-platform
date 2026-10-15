// @vitest-environment happy-dom
import "../register-session-catalog.ts";
import type { Dialog, InboxItem } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n/index.ts";
import type { Runtime } from "../../../runtime/index.ts";
import { useInboxStore } from "../../../stores/inbox-store.ts";
import { mount, text, type Mounted } from "../../../testing/dom.ts";
import { fakeRuntime } from "../../../testing/runtime-bed.ts";
import { DialogList } from "./DialogList.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const itemOf = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: "i1",
  kind: "task_needs_input",
  toHandle: true,
  taskId: "t1",
  sessionId: "s1",
  triggerName: "prod-alerts",
  costUsd: 0.21,
  createdAt: 1_000,
  readAt: null,
  resolvedAt: null,
  resolution: null,
  ...over,
});
const loadInbox = (items: InboxItem[]) =>
  useInboxStore
    .getState()
    .apply({ kind: "snapshot", items, unread: items.length, toHandle: items.length, truncated: false });

let mounted: Mounted | null = null;
beforeEach(() => {
  current.runtime = fakeRuntime().runtime;
  useInboxStore.getState().reset();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  useInboxStore.getState().reset();
  setLocale("en");
});

const approval: Dialog = {
  id: "a1",
  method: "approval",
  category: "exec",
  title: "Run a command?",
  message: "1 line\nbash: ls",
  answers: ["deny", "once"],
};
const show = async (sessionId = "sess-1") => {
  mounted = await mount(<DialogList sessionId={sessionId} dialogs={[approval]} hidden={0} />);
  return mounted.container;
};
const line = (page: Element) => page.querySelector("[data-approval-trigger]");

describe("the trigger on a task's approval card", () => {
  it("reads 'Started by trigger prod-alerts' in a session with an unresolved task question", async () => {
    loadInbox([itemOf({ sessionId: "sess-1", triggerName: "prod-alerts" })]);
    const page = await show();
    expect(line(page)?.textContent).toBe("Started by trigger prod-alerts");
    expect(page.querySelector("[data-approval-question]")).not.toBeNull();
  });

  it("says it in French", async () => {
    setLocale("fr");
    loadInbox([itemOf({ sessionId: "sess-1", triggerName: "prod-alerts" })]);
    expect(line(await show())?.textContent).toBe("Démarrée par le déclencheur prod-alerts");
  });

  it("has no such line in an ordinary session", async () => {
    loadInbox([itemOf({ sessionId: "another" })]);
    const page = await show();
    expect(line(page)).toBeNull();
    expect(text(page)).not.toContain("Started by trigger");
  });

  it("has none when the question is resolved, or the item is not a question", async () => {
    loadInbox([
      itemOf({ id: "i1", sessionId: "sess-1", resolvedAt: 5, resolution: "answered" }),
      itemOf({ id: "i2", sessionId: "sess-1", kind: "task_done", toHandle: false }),
    ]);
    expect(line(await show())).toBeNull();
  });

  it("renders a hostile name as capped text of at most three lines", async () => {
    loadInbox([
      itemOf({ sessionId: "sess-1", triggerName: `<img src=x onerror=alert(1)>‮${"n".repeat(250)}` }),
    ]);
    const page = await show();
    expect(page.querySelector("img")).toBeNull();
    const shown = line(page)?.textContent ?? "";
    expect(shown).toContain("<img src=x onerror=alert(1)>\\u202E");
    expect(shown.length).toBeLessThan(140);
    expect(line(page)?.className).toContain("line-clamp-3");
  });
});

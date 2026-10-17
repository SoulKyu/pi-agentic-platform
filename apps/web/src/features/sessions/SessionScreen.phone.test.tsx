// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { setLocale } from "../../i18n/index.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { mount, settle, type Mounted } from "../../testing/dom.ts";
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

const approval = {
  id: "a1",
  method: "approval",
  title: "Run a command?",
  message: "1 character, 1 line\nbash: ls",
  category: "exec",
  answers: ["deny", "session", "once"],
};
const snapshot = {
  kind: "snapshot",
  status: "running",
  rows: [],
  dialogs: [approval],
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
};

async function show(phone: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: phone && query === "(max-width: 767.98px)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  page = await mount(<SessionScreen sessionId="sess-1" />);
  await settle();
  bed.emit(snapshot);
  await settle();
  return page.container;
}

beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  useSessionStore.setState({ views: {} });
  setLocale("en");
});
afterEach(async () => {
  await page?.unmount();
  page = null;
  vi.unstubAllGlobals();
});

describe("a session's approval card on a phone (decision 32, board 12)", () => {
  it("is full width, above the thread, with every action a 44 px target", async () => {
    const container = await show(true);
    const card = container.querySelector('[role="alertdialog"]');
    expect(card?.className).toContain("w-full");
    const buttons = [...(card?.querySelectorAll("button") ?? [])];
    expect(buttons.map((one) => one.textContent)).toEqual(["Deny", "Session", "Allow once"]);
    for (const one of buttons) {
      expect(one.className).toContain("pointer-coarse:min-h-11");
      expect(one.className).toContain("pointer-coarse:min-w-11");
      expect(one.className).toContain("h-control");
    }
    expect(card?.querySelector("[data-approval-actions]")?.className).toContain("w-full");
    const transcript = container.querySelector("ol");
    expect(transcript).not.toBeNull();
    expect(card?.compareDocumentPosition(transcript as Node) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("keeps the desktop card as it was: below the thread, content width", async () => {
    const container = await show(false);
    const card = container.querySelector('[role="alertdialog"]');
    expect(card?.className).not.toContain("w-full");
    expect(card?.querySelector("[data-approval-actions]")?.className).not.toContain("w-full");
    const transcript = container.querySelector("ol");
    expect(card?.compareDocumentPosition(transcript as Node) ?? 0).toBe(Node.DOCUMENT_POSITION_PRECEDING);
  });
});

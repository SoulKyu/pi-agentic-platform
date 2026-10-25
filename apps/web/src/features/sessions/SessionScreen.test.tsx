// @vitest-environment happy-dom
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { alerts, button, click, mount, settle, text, type Mounted } from "../../testing/dom.ts";
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

const user = { role: "user", content: "Run the check", timestamp: 1 };
const reply = { role: "assistant", content: [{ type: "text", text: "All green." }], timestamp: 2 };
const snapshot = (status: string, messages: unknown[] = [], dialogs: unknown[] = []) => ({
  kind: "snapshot",
  status,
  rows: messages.map((message) => ({ entryId: null, message })),
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
const confirm = (message: string) => ({ id: "d1", method: "confirm", title: "Run a command?", message });
const approval = (message: string) => ({
  id: "d1",
  method: "approval",
  title: "Run a command?",
  message,
  category: "exec",
  answers: ["deny", "once"],
});

async function show(strict = false) {
  const screen = <SessionScreen sessionId="sess-1" />;
  page = await mount(strict ? <StrictMode>{screen}</StrictMode> : screen);
  await settle();
  return page.container;
}
async function emit(event: unknown) {
  bed.emit(event);
  await settle();
}

beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  useSessionStore.setState({ views: {} });
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("SessionScreen feed", () => {
  it("runs one feed per session id, even when StrictMode mounts the screen twice", async () => {
    await show(true);
    expect(bed.called("subscribe.session")).toEqual([
      { method: "subscribe.session", params: { sessionId: "sess-1" } },
    ]);
  });

  it("ends the feed when the screen goes away", async () => {
    await show();
    await page?.unmount();
    page = null;
    expect(bed.called("unsubscribe")).toContainEqual({ method: "unsubscribe", params: { sub: "s1" } });
  });

  it("builds the transcript from a snapshot and live events, and shows the streamed reply", async () => {
    const container = await show();
    await emit(snapshot("running", [user]));
    expect(text(container)).toContain("Run the check");
    await emit({ kind: "pi", event: { type: "message_start", message: { role: "assistant" } } });
    await emit({
      kind: "pi",
      event: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "All " },
      },
    });
    expect(text(container)).toContain("All");
    await emit({ kind: "pi", event: { type: "message_end", message: reply } });
    expect(container.querySelectorAll('[data-slot="message"][data-author="agent"]')).toHaveLength(1);
    expect(container.querySelector('[data-slot="message"][data-author="agent"]')?.textContent).toContain(
      "All green.",
    );
    expect(container.querySelector('[data-slot="message"][data-author="you"]')?.textContent).toContain(
      "Run the check",
    );
  });

  it("shows the missing-session screen when the subscription is refused as not found, without subscribing again", async () => {
    bed.handlers["subscribe.session"] = () => {
      throw new RpcError("not_found");
    };
    const container = await show();
    expect(container.querySelector("[data-session-missing]")).not.toBeNull();
    expect(alerts(container)).toEqual([]);
    expect(bed.called("subscribe.session")).toHaveLength(1);
  });

  it("shows a killed worker as the crash banner, with the cause", async () => {
    const container = await show();
    await emit({
      kind: "status",
      status: "cold",
      cause: "Agent process killed (SIGKILL), possibly out of memory.",
    });
    expect(container.querySelector("[data-crash-cause]")?.textContent).toBe(
      "Agent process killed (SIGKILL), possibly out of memory.",
    );
    expect(alerts(container)).toHaveLength(1);
  });
});

describe("SessionScreen provider failures", () => {
  it("shows why the model failed, as plain text, and announces it when it is the last thing said", async () => {
    const container = await show();
    await emit(
      snapshot("idle", [
        user,
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: '429 usage limit <img src=x onerror="alert(1)">',
          timestamp: 2,
        },
      ]),
    );
    const failure = container.querySelector("[data-failure]");
    expect(failure?.textContent).toContain('429 usage limit <img src=x onerror="alert(1)">');
    expect(container.querySelector("img")).toBeNull();
    expect(failure?.getAttribute("role")).toBe("alert");
  });

  it("shows a failure that happens during a run, from the live stream", async () => {
    const container = await show();
    await emit(snapshot("running", [user]));
    await emit({
      kind: "pi",
      event: {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "overloaded",
          timestamp: 5,
        },
      },
    });
    expect(container.querySelector("[data-failure]")?.textContent).toContain("overloaded");
  });
});

describe("SessionScreen unreadable snapshot", () => {
  it("says so instead of staying blank (M2-RT-06)", async () => {
    const container = await show();
    await emit({ kind: "snapshot", rows: 5 });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "This session could not be shown. Reload the page; if it stays, the session file may be damaged.",
    );
  });
});

describe("SessionScreen approvals", () => {
  const card = (container: HTMLElement) => container.querySelector('[role="alertdialog"]') as HTMLElement;

  it("shows the approval card with the question and the size header pinned above the command", async () => {
    const container = await show();
    await emit(snapshot("running", [], [approval("12 characters, 1 line\nbash: echo hello")]));
    expect(card(container).getAttribute("aria-label")).toBe("Approval exec");
    // The separator is an aria-hidden span: the heading's text is "Approval·exec", never "Approval · exec".
    expect(container.querySelector("h2")?.textContent).toBe("Approval·exec");
    expect(card(container).querySelector("[data-approval-header]")?.textContent).toBe(
      "12 characters, 1 line",
    );
    expect(card(container).querySelector("[data-approval-scroll]")?.textContent).toBe("bash: echo hello");
  });

  it("keeps the header outside the scrolling region however long the command is (R91)", async () => {
    const padded = `start${"\n".repeat(400)}TAIL-OF-THE-COMMAND`;
    const container = await show();
    await emit(
      snapshot("running", [], [approval(`${padded.length} characters, 401 lines\nbash: ${padded}`)]),
    );
    const header = card(container).querySelector("[data-approval-header]");
    const scroll = card(container).querySelector("[data-approval-scroll]");
    expect(header?.textContent).toContain("401 lines");
    expect(scroll?.contains(header ?? null)).toBe(false);
    // 401 lines are clipped to 200 until the owner asks for the rest; the header says how much there is.
    expect(scroll?.textContent?.includes("TAIL-OF-THE-COMMAND")).toBe(false);
    await click(button(container, "Show more"));
    expect(scroll?.textContent?.endsWith("TAIL-OF-THE-COMMAND")).toBe(true);
    expect(scroll?.className).not.toMatch(/max-h|overflow/);
  });

  it("answers Yes with confirmed: true, exactly once", async () => {
    const container = await show();
    await emit(snapshot("running", [], [confirm("1 character, 1 line\nbash: ls")]));
    await click(button(container, "Yes"));
    await click(button(container, "No"));
    await settle();
    expect(bed.called("sessions.respondDialog").map((call) => call.params)).toEqual([
      { sessionId: "sess-1", dialogId: "d1", response: { confirmed: true } },
    ]);
  });

  it("answers No with confirmed: false, and the card goes when the server closes the dialog", async () => {
    const container = await show();
    await emit(snapshot("running", [], [confirm("1 character, 1 line\nbash: ls")]));
    await click(button(container, "No"));
    await settle();
    expect(bed.called("sessions.respondDialog")[0]?.params).toMatchObject({ response: { confirmed: false } });
    await emit({ kind: "dialog_closed", id: "d1" });
    expect(card(container)).toBeNull();
  });

  it("re-arms the card when the answer could not be delivered, so a second click goes through (R127.1)", async () => {
    let tries = 0;
    bed.handlers["sessions.respondDialog"] = () => {
      if (++tries === 1) throw new RpcError("offline");
      return { ok: true };
    };
    const container = await show();
    await emit(snapshot("running", [], [confirm("1 character, 1 line\nbash: ls")]));
    await click(button(container, "Yes"));
    await settle();
    expect(alerts(container)).toEqual([
      "pap is unreachable: this page cannot reach the daemon. Your drafts stay on this device. Check that pap is running, then retry.",
    ]);
    expect(button(container, "Yes").disabled).toBe(false);
    expect(button(container, "No").disabled).toBe(false);
    await click(button(container, "Yes"));
    await settle();
    expect(bed.called("sessions.respondDialog").map((call) => call.params)).toEqual([
      { sessionId: "sess-1", dialogId: "d1", response: { confirmed: true } },
      { sessionId: "sess-1", dialogId: "d1", response: { confirmed: true } },
    ]);
    expect(alerts(container)).toEqual([]);
  });

  it("keeps the card shut after a lost connection, even when the snapshot brings the same dialog back, and sends the same answer again with the same command id (R105)", async () => {
    let tries = 0;
    bed.handlers["sessions.respondDialog"] = () => {
      if (++tries === 1) throw new RpcError("connection_lost");
      return { ok: true };
    };
    const container = await show();
    const dialogs = [confirm("1 character, 1 line\nbash: ls")];
    await emit(snapshot("running", [], dialogs));
    await click(button(container, "No"));
    await settle();
    await emit(snapshot("running", [], [...dialogs]));
    expect(button(container, "No").disabled).toBe(true);
    await click(button(container, "Send again"));
    await settle();
    const calls = bed.called("sessions.respondDialog");
    expect(calls.map((call) => call.params)).toHaveLength(2);
    expect(calls[1]?.options?.commandId).toBe(calls[0]?.options?.commandId);
  });

  it("shows an extension's select and answers its Cancel", async () => {
    const container = await show();
    await emit(
      snapshot("running", [], [{ id: "d2", method: "select", title: "Pick one", options: ["a", "b"] }]),
    );
    expect(alerts(container)).toEqual([]);
    await click(button(container, "Cancel"));
    await settle();
    expect(bed.called("sessions.respondDialog")[0]?.params).toEqual({
      sessionId: "sess-1",
      dialogId: "d2",
      response: { cancelled: true },
    });
  });

  it("says how many dialogs the snapshot could not carry", async () => {
    const container = await show();
    await emit({ ...snapshot("running", [], []), hiddenDialogs: 2 });
    expect(container.textContent).toContain("2 more dialogs are waiting");
  });

  it("asks one fresh snapshot when a shown dialog closes while others are hidden (M4R111)", async () => {
    await show();
    await emit({ ...snapshot("running", [], [confirm("ls")]), hiddenDialogs: 1 });
    expect(bed.called("subscribe.session")).toHaveLength(1);
    await emit({ kind: "dialog_closed", id: "d1" });
    expect(bed.called("subscribe.session")).toEqual([
      { method: "subscribe.session", params: { sessionId: "sess-1" } },
      { method: "subscribe.session", params: { sessionId: "sess-1" } },
    ]);
  });

  it("shows a failure to deliver the answer", async () => {
    bed.handlers["sessions.respondDialog"] = () => {
      throw new RpcError("not_found");
    };
    const container = await show();
    await emit(snapshot("running", [], [confirm("1 character, 1 line\nbash: ls")]));
    await click(button(container, "Yes"));
    await settle();
    expect(alerts(container)).toEqual([
      "This item no longer exists: it was deleted, or the link is wrong. Nothing else was changed. Pick it again from its list.",
    ]);
  });
});

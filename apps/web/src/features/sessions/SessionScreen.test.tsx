// @vitest-environment happy-dom
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import {
  alerts,
  button,
  click,
  field,
  hasButton,
  mount,
  press,
  settle,
  text,
  typeInto,
  type Mounted,
} from "../../testing/dom.ts";
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

const user = { role: "user", content: "Run the check", timestamp: 1 };
const reply = { role: "assistant", content: [{ type: "text", text: "All green." }], timestamp: 2 };
const snapshot = (status: string, messages: unknown[] = [], dialogs: unknown[] = []) => ({
  kind: "snapshot",
  status,
  messages,
  dialogs,
});
const confirm = (message: string) => ({ id: "d1", method: "confirm", title: "Run a command?", message });

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
    expect(bed.called("unsubscribe")).toEqual([{ method: "unsubscribe", params: { sub: "s1" } }]);
  });

  it("builds the transcript from a snapshot and live events, and shows the streamed reply", async () => {
    const container = await show();
    await emit(snapshot("running", [user]));
    expect(text(container)).toContain("Run the check");
    await emit({ kind: "pi", event: { type: "message_start", message: { role: "assistant" } } });
    await emit({
      kind: "pi",
      event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "All " } },
    });
    expect(text(container)).toContain("All");
    await emit({ kind: "pi", event: { type: "message_end", message: reply } });
    expect(container.querySelectorAll('[data-author="agent"]')).toHaveLength(1);
    expect(container.querySelector('[data-author="agent"]')?.textContent).toContain("All green.");
    expect(container.querySelector('[data-author="you"]')?.textContent).toContain("Run the check");
  });

  it("shows why a subscription was refused, without subscribing again", async () => {
    bed.handlers["subscribe.session"] = () => {
      throw new RpcError("not_found");
    };
    const container = await show();
    expect(alerts(container)).toEqual(["Not found."]);
    expect(bed.called("subscribe.session")).toHaveLength(1);
  });

  it("shows an error notice such as a killed worker as an alert", async () => {
    const container = await show();
    await emit({
      kind: "status",
      status: "cold",
      cause: "Agent process killed (SIGKILL), possibly out of memory.",
    });
    expect(alerts(container)).toEqual(["Agent process killed (SIGKILL), possibly out of memory."]);
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

describe("SessionScreen composer", () => {
  it("sends the message, empties the composer and keeps Send off while it is empty", async () => {
    const container = await show();
    await emit(snapshot("idle"));
    expect(button(container, "Send").disabled).toBe(true);
    await typeInto(field(container, "Message"), "  hello  ");
    await click(button(container, "Send"));
    await settle();
    expect(bed.called("sessions.prompt")).toEqual([
      { method: "sessions.prompt", params: { sessionId: "sess-1", text: "hello" } },
    ]);
    expect(field(container, "Message").value).toBe("");
  });

  it("sends on Ctrl+Enter and keeps the browser from also adding a newline", async () => {
    const container = await show();
    await typeInto(field(container, "Message"), "hello");
    const plain = await press(field(container, "Message"), { key: "Enter" });
    expect(plain.defaultPrevented).toBe(false);
    expect(bed.called("sessions.prompt")).toEqual([]);
    const shortcut = await press(field(container, "Message"), { key: "Enter", ctrlKey: true });
    await settle();
    expect(shortcut.defaultPrevented).toBe(true);
    expect(bed.called("sessions.prompt")[0]?.params).toEqual({ sessionId: "sess-1", text: "hello" });
    expect(field(container, "Message").value).toBe("");
  });

  it("queues a follow-up while the session is running", async () => {
    const container = await show();
    await emit(snapshot("running"));
    await typeInto(field(container, "Message"), "and then?");
    await click(button(container, "Send"));
    await settle();
    expect(bed.called("sessions.prompt")[0]?.params).toEqual({
      sessionId: "sess-1",
      text: "and then?",
      streamingBehavior: "followUp",
    });
  });

  it("puts the text back when the prompt was refused, so it is not lost", async () => {
    bed.handlers["sessions.prompt"] = () => {
      throw new RpcError("prompt_rejected");
    };
    const container = await show();
    await typeInto(field(container, "Message"), "do it");
    await click(button(container, "Send"));
    await settle();
    expect(alerts(container)).toEqual([
      "The session could not start this prompt. Check the model and provider settings.",
    ]);
    expect(field(container, "Message").value).toBe("do it");
  });

  it("keeps the text out of the composer when the outcome is unknown (R105)", async () => {
    bed.handlers["sessions.prompt"] = () => {
      throw new RpcError("timeout");
    };
    const container = await show();
    await typeInto(field(container, "Message"), "do it");
    await click(button(container, "Send"));
    await settle();
    expect(alerts(container)[0]).toContain("may still have gone through");
    expect(field(container, "Message").value).toBe("");
  });

  it("does not overwrite what was typed meanwhile when it puts a refused message back", async () => {
    let refuse: (error: unknown) => void = () => {};
    bed.handlers["sessions.prompt"] = () => new Promise((_resolve, reject) => (refuse = reject));
    const container = await show();
    await typeInto(field(container, "Message"), "first");
    await click(button(container, "Send"));
    await typeInto(field(container, "Message"), "second");
    refuse(new RpcError("capacity"));
    await settle();
    expect(field(container, "Message").value).toBe("second");
  });

  it("offers Stop only while running, as a secondary button (R21), and aborts the session", async () => {
    const container = await show();
    await emit(snapshot("idle"));
    expect(hasButton(container, "Stop")).toBe(false);
    await emit({ kind: "status", status: "running" });
    const stop = button(container, "Stop");
    expect(stop.className).toContain("bg-panel");
    expect(stop.className).not.toContain("border-error");
    await click(stop);
    await settle();
    expect(bed.called("sessions.abort")).toEqual([
      { method: "sessions.abort", params: { sessionId: "sess-1" } },
    ]);
  });
});

describe("SessionScreen approvals", () => {
  const card = (container: HTMLElement) => container.querySelector('[role="alertdialog"]') as HTMLElement;

  it("shows the approval card with the question and the size header pinned above the command", async () => {
    const container = await show();
    await emit(snapshot("running", [], [confirm("12 characters, 1 line\nbash: echo hello")]));
    expect(card(container).getAttribute("aria-label")).toBe("Approval needed");
    expect(card(container).querySelector("[data-approval-header]")?.textContent).toBe(
      "Run a command? · 12 characters, 1 line",
    );
    expect(card(container).querySelector("[data-approval-scroll]")?.textContent).toBe("bash: echo hello");
  });

  it("keeps the header outside the scrolling region however long the command is (R91)", async () => {
    const padded = `start${"\n".repeat(400)}TAIL-OF-THE-COMMAND`;
    const container = await show();
    await emit(snapshot("running", [], [confirm(`${padded.length} characters, 401 lines\nbash: ${padded}`)]));
    const header = card(container).querySelector("[data-approval-header]");
    const scroll = card(container).querySelector("[data-approval-scroll]");
    expect(header?.textContent).toContain("401 lines");
    expect(scroll?.contains(header ?? null)).toBe(false);
    expect(scroll?.textContent?.endsWith("TAIL-OF-THE-COMMAND")).toBe(true);
    expect(scroll?.className).toContain("overflow-auto");
  });

  it("answers Allow once with confirmed: true, exactly once", async () => {
    const container = await show();
    await emit(snapshot("running", [], [confirm("1 character, 1 line\nbash: ls")]));
    await click(button(container, "Allow once"));
    await click(button(container, "Deny"));
    await settle();
    expect(bed.called("sessions.respondDialog")).toEqual([
      {
        method: "sessions.respondDialog",
        params: { sessionId: "sess-1", dialogId: "d1", response: { confirmed: true } },
      },
    ]);
  });

  it("answers Deny with confirmed: false, and the card goes when the server closes the dialog", async () => {
    const container = await show();
    await emit(snapshot("running", [], [confirm("1 character, 1 line\nbash: ls")]));
    await click(button(container, "Deny"));
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
    await click(button(container, "Allow once"));
    await settle();
    expect(alerts(container)).toEqual(["pap is unreachable right now."]);
    expect(button(container, "Allow once").disabled).toBe(false);
    expect(button(container, "Deny").disabled).toBe(false);
    await click(button(container, "Allow once"));
    await settle();
    expect(bed.called("sessions.respondDialog").map((call) => call.params)).toEqual([
      { sessionId: "sess-1", dialogId: "d1", response: { confirmed: true } },
      { sessionId: "sess-1", dialogId: "d1", response: { confirmed: true } },
    ]);
    expect(alerts(container)).toEqual([]);
  });

  it("re-arms the card after a lost connection even when the snapshot brings the same dialog back", async () => {
    let tries = 0;
    bed.handlers["sessions.respondDialog"] = () => {
      if (++tries === 1) throw new RpcError("connection_lost");
      return { ok: true };
    };
    const container = await show();
    const dialogs = [confirm("1 character, 1 line\nbash: ls")];
    await emit(snapshot("running", [], dialogs));
    await click(button(container, "Deny"));
    await settle();
    await emit(snapshot("running", [], dialogs));
    await click(button(container, "Deny"));
    await settle();
    expect(bed.called("sessions.respondDialog")).toHaveLength(2);
  });

  it("cancels a dialog it cannot show, and says so", async () => {
    const container = await show();
    await emit(
      snapshot("running", [], [{ id: "d2", method: "select", title: "Pick one", options: ["a", "b"] }]),
    );
    expect(alerts(container)).toEqual(["An extension asked for input that this screen cannot show yet."]);
    await click(button(container, "Cancel"));
    await settle();
    expect(bed.called("sessions.respondDialog")[0]?.params).toEqual({
      sessionId: "sess-1",
      dialogId: "d2",
      response: { cancelled: true },
    });
  });

  it("shows a failure to deliver the answer", async () => {
    bed.handlers["sessions.respondDialog"] = () => {
      throw new RpcError("not_found");
    };
    const container = await show();
    await emit(snapshot("running", [], [confirm("1 character, 1 line\nbash: ls")]));
    await click(button(container, "Allow once"));
    await settle();
    expect(alerts(container)).toEqual(["Not found."]);
  });
});

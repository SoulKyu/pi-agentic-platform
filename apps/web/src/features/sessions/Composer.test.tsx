// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { alerts, button, click, field, hasButton, press, settle, text, typeInto } from "../../testing/dom.ts";
import { screenBed } from "../../testing/screen-bed.tsx";

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

const screen = screenBed(current);
const { show, emit, methods } = screen;

describe("Composer sending", () => {
  it("restores the draft, sends with the preference and clears the draft once accepted", async () => {
    localStorage.setItem("pap.draft.sess-1", "half a thought");
    const container = await show({ status: "idle" });
    expect(field(container, "Message").value).toBe("half a thought");
    await click(button(container, "Send"));
    await settle();
    expect(screen.bed.called("sessions.prompt")).toEqual([
      {
        method: "sessions.prompt",
        params: { sessionId: "sess-1", text: "half a thought", streamingBehavior: "steer" },
        options: { commandId: expect.any(String) },
      },
    ]);
    expect(localStorage.getItem("pap.draft.sess-1")).toBeNull();
  });

  it("keeps Send off while the message is blank, saves the draft as it is typed, sends as typed", async () => {
    const container = await show({ status: "idle" });
    expect(button(container, "Send").disabled).toBe(true);
    await typeInto(field(container, "Message"), "    const x = 1;\n");
    expect(localStorage.getItem("pap.draft.sess-1")).toBe("    const x = 1;\n");
    await click(button(container, "Send"));
    await settle();
    expect(screen.bed.called("sessions.prompt")[0]?.params).toMatchObject({ text: "    const x = 1;" });
    expect(field(container, "Message").value).toBe("");
  });

  it("sends on Ctrl+Enter and keeps the browser from also adding a newline", async () => {
    const container = await show({ status: "idle" });
    await typeInto(field(container, "Message"), "hello");
    expect((await press(field(container, "Message"), { key: "Enter" })).defaultPrevented).toBe(false);
    expect(screen.bed.called("sessions.prompt")).toEqual([]);
    const shortcut = await press(field(container, "Message"), { key: "Enter", ctrlKey: true });
    await settle();
    expect(shortcut.defaultPrevented).toBe(true);
    expect(screen.bed.called("sessions.prompt")[0]?.params).toEqual({
      sessionId: "sess-1",
      text: "hello",
      streamingBehavior: "steer",
    });
  });

  it("puts the text back with the error when the prompt is refused", async () => {
    screen.bed.handlers["sessions.prompt"] = () => {
      throw new RpcError("queue_full");
    };
    const container = await show({ status: "running" });
    await typeInto(field(container, "Message"), "one more");
    await click(button(container, "Steer"));
    await settle();
    expect(field(container, "Message").value).toBe("one more");
    expect(alerts(container)).toContain(
      "Too many messages are waiting in this session. Wait for the agent, or clear the queue.",
    );
  });

  it("does not overwrite what was typed meanwhile when it puts a refused message back", async () => {
    let refuse: (error: unknown) => void = () => {};
    screen.bed.handlers["sessions.prompt"] = () => new Promise((_resolve, reject) => (refuse = reject));
    const container = await show({ status: "idle" });
    await typeInto(field(container, "Message"), "first");
    await click(button(container, "Send"));
    await typeInto(field(container, "Message"), "second");
    refuse(new RpcError("capacity"));
    await settle();
    expect(field(container, "Message").value).toBe("first\n\nsecond");
  });
});

describe("Composer while the agent works", () => {
  it("offers Steer, Follow up and Stop, the preferred way primary, and remembers the way last used per device", async () => {
    const container = await show({ status: "running" });
    expect(hasButton(container, "Send")).toBe(false);
    expect(container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe(
      "While the agent works",
    );
    expect(button(container, "Steer").dataset.variant).toBe("primary");
    expect(button(container, "Follow up").dataset.variant).toBe("secondary");
    expect(button(container, "Stop").dataset.variant).toBe("secondary");
    await typeInto(field(container, "Message"), "then this");
    await click(button(container, "Follow up"));
    await settle();
    expect(screen.bed.called("sessions.prompt")[0]?.params).toMatchObject({ streamingBehavior: "followUp" });
    expect(localStorage.getItem("pap.sessions.streaming")).toBe("followUp");
    expect(button(container, "Follow up").dataset.variant).toBe("primary");
    expect(button(container, "Steer").dataset.variant).toBe("secondary");
    await typeInto(field(container, "Message"), "and this");
    await press(field(container, "Message"), { key: "Enter", ctrlKey: true });
    await settle();
    expect(screen.bed.called("sessions.prompt")[1]?.params).toMatchObject({ streamingBehavior: "followUp" });
  });

  it("Steer sends a steer whatever the preference is", async () => {
    localStorage.setItem("pap.sessions.streaming", "followUp");
    const container = await show({ status: "running" });
    await typeInto(field(container, "Message"), "change course");
    await click(button(container, "Steer"));
    await settle();
    expect(screen.bed.called("sessions.prompt")[0]?.params).toMatchObject({ streamingBehavior: "steer" });
  });

  it("shows Stop only when something can be stopped: running, compacting, or refused as busy (M2R89)", async () => {
    const container = await show({ status: "idle" });
    expect(hasButton(container, "Stop")).toBe(false);
    await emit({ kind: "activity", activity: { compacting: true, retry: null } });
    expect(hasButton(container, "Stop")).toBe(true);
    await emit({ kind: "activity", activity: { compacting: false, retry: null } });
    expect(hasButton(container, "Stop")).toBe(false);
    screen.bed.handlers["sessions.prompt"] = () => {
      throw new RpcError("session_busy");
    };
    await typeInto(field(container, "Message"), "go");
    await click(button(container, "Send"));
    await settle();
    expect(alerts(container)).toContain("The session is working. Wait for it to finish, or stop it first.");
    expect(hasButton(container, "Stop")).toBe(true);
    await click(button(container, "Stop"));
    await settle();
    expect(screen.bed.called("sessions.abort")).toHaveLength(1);
    expect(hasButton(container, "Stop")).toBe(false);
  });

  it("disables Send while the session compacts (M2-RT-34)", async () => {
    const container = await show({ status: "idle", activity: { compacting: true, retry: null } });
    await typeInto(field(container, "Message"), "wait for me");
    expect(button(container, "Send").disabled).toBe(true);
  });

  it("sends nothing on Ctrl+Enter while the session compacts either", async () => {
    const container = await show({ status: "idle", activity: { compacting: true, retry: null } });
    await typeInto(field(container, "Message"), "wait for me");
    await press(field(container, "Message"), { key: "Enter", ctrlKey: true });
    await settle();
    expect(screen.bed.called("sessions.prompt")).toEqual([]);
    expect(field(container, "Message").value).toBe("wait for me");
  });

  it("disables Steer and Follow up while a running session compacts", async () => {
    const container = await show({ status: "running", activity: { compacting: true, retry: null } });
    await typeInto(field(container, "Message"), "wait for me");
    expect([button(container, "Steer").disabled, button(container, "Follow up").disabled]).toEqual([
      true,
      true,
    ]);
  });
});

describe("Composer Stop", () => {
  it("clears the queue, aborts, and puts the cleared texts in the draft", async () => {
    screen.bed.handlers["sessions.clearQueue"] = () => ({
      steering: ["left"],
      followUp: ["then"],
      truncated: false,
    });
    const container = await show({
      status: "running",
      queue: { steering: ["left"], followUp: ["then"], count: 2, bytes: 8 },
    });
    expect(text(container)).toContain("Waiting · 2");
    await click(button(container, "Stop"));
    await settle();
    expect(methods()).toEqual(["sessions.clearQueue", "sessions.abort"]);
    expect(field(container, "Message").value).toBe("left\n\nthen");
    expect(localStorage.getItem("pap.draft.sess-1")).toBe("left\n\nthen");
  });

  it("still aborts when clearing the queue fails, and shows only the abort's failure (M2-RT-09)", async () => {
    screen.bed.handlers["sessions.clearQueue"] = () => {
      throw new RpcError("timeout");
    };
    const container = await show({ status: "running" });
    await click(button(container, "Stop"));
    await settle();
    expect(methods()).toEqual(["sessions.clearQueue", "sessions.abort"]);
    expect(alerts(container)).toEqual([]);
    screen.bed.handlers["sessions.abort"] = () => {
      throw new RpcError("worker_failed");
    };
    await click(button(container, "Stop"));
    await settle();
    expect(alerts(container)).toContain("The session process failed.");
  });

  it("keeps what was cleared in the draft even when the abort fails", async () => {
    screen.bed.handlers["sessions.clearQueue"] = () => ({
      steering: ["kept"],
      followUp: [],
      truncated: false,
    });
    screen.bed.handlers["sessions.abort"] = () => {
      throw new RpcError("worker_failed");
    };
    const container = await show({ status: "running" });
    await click(button(container, "Stop"));
    await settle();
    expect(field(container, "Message").value).toBe("kept");
    expect(alerts(container)).toContain("The session process failed.");
  });

  it("the queue strip's Clear puts the waiting texts back in the draft, and shows a failure", async () => {
    screen.bed.handlers["sessions.clearQueue"] = () => ({
      steering: ["a"],
      followUp: ["b"],
      truncated: false,
    });
    const container = await show({
      status: "running",
      queue: { steering: ["a"], followUp: ["b"], count: 2, bytes: 2 },
    });
    await typeInto(field(container, "Message"), "mine");
    await click(button(container, "Clear"));
    await settle();
    expect(field(container, "Message").value).toBe("a\n\nb\n\nmine");
    expect(methods()).toEqual(["sessions.clearQueue"]);
    screen.bed.handlers["sessions.clearQueue"] = () => {
      throw new RpcError("worker_failed");
    };
    await click(button(container, "Clear"));
    await settle();
    expect(alerts(container)).toContain("The session process failed.");
  });
});

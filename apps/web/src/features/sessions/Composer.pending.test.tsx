// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { Composer } from "./Composer.tsx";
import { describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { alerts, button, click, field, hasButton, press, settle, text, typeInto } from "../../testing/dom.ts";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
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
  };
});

const screen = screenBed(current);
const { show, emit, remount } = screen;
describe("Composer outcome unknown", () => {
  it("offers Send again with the same command id, and Edit puts the text back", async () => {
    screen.bed.handlers["sessions.prompt"] = () => {
      throw new RpcError("connection_lost");
    };
    const container = await show({ status: "idle" });
    await typeInto(field(container, "Message"), "deploy");
    await click(button(container, "Send"));
    await settle();
    expect(field(container, "Message").value).toBe("");
    expect(text(container)).toContain("The message may have been sent.");
    expect(button(container, "Send").disabled).toBe(true);
    screen.bed.handlers["sessions.prompt"] = () => ({ disposition: "started" });
    await click(button(container, "Send again"));
    await settle();
    const [first, second] = screen.bed.called("sessions.prompt");
    expect(second?.options?.commandId).toBe(first?.options?.commandId);
    expect(second?.params).toEqual(first?.params);
    expect(hasButton(container, "Send again")).toBe(false);
    expect(localStorage.getItem("pap.pending.sess-1")).toBeNull();
  });

  it("Edit gives the text back in the draft and forgets the pending send", async () => {
    screen.bed.handlers["sessions.prompt"] = () => {
      throw new RpcError("timeout");
    };
    const container = await show({ status: "idle" });
    await typeInto(field(container, "Message"), "deploy");
    await click(button(container, "Send"));
    await settle();
    expect(localStorage.getItem("pap.pending.sess-1")).not.toBeNull();
    await typeInto(field(container, "Message"), "newer");
    await click(button(container, "Edit"));
    expect(field(container, "Message").value).toBe("deploy\n\nnewer");
    expect(localStorage.getItem("pap.pending.sess-1")).toBeNull();
    expect(hasButton(container, "Send again")).toBe(false);
  });

  it("keeps an outcome-unknown send across a reload, and Send again reuses its command id (M2-RT-35)", async () => {
    localStorage.setItem(
      "pap.pending.sess-1",
      JSON.stringify({
        params: { sessionId: "sess-1", text: "deploy", streamingBehavior: "steer" },
        commandId: "c-kept",
      }),
    );
    screen.bed.handlers["sessions.prompt"] = () => ({ disposition: "started" });
    const container = await show({ status: "idle" });
    expect(text(container)).toContain("The message may have been sent.");
    await click(button(container, "Send again"));
    await settle();
    expect(screen.bed.called("sessions.prompt")[0]?.options).toEqual({ commandId: "c-kept" });
    expect(localStorage.getItem("pap.pending.sess-1")).toBeNull();
  });

  it("keeps it pending when the second try is unknown again, and gives the text back when it is refused", async () => {
    localStorage.setItem(
      "pap.pending.sess-1",
      JSON.stringify({
        params: { sessionId: "sess-1", text: "deploy", streamingBehavior: "steer" },
        commandId: "c-kept",
      }),
    );
    screen.bed.handlers["sessions.prompt"] = () => {
      throw new RpcError("timeout");
    };
    const container = await show({ status: "idle" });
    await click(button(container, "Send again"));
    await settle();
    expect(hasButton(container, "Send again")).toBe(true);
    expect(localStorage.getItem("pap.pending.sess-1")).not.toBeNull();
    screen.bed.handlers["sessions.prompt"] = () => {
      throw new RpcError("prompt_rejected");
    };
    await click(button(container, "Send again"));
    await settle();
    expect(hasButton(container, "Send again")).toBe(false);
    expect(localStorage.getItem("pap.pending.sess-1")).toBeNull();
    expect(field(container, "Message").value).toBe("deploy");
    expect(alerts(container)).toContain(
      "The session could not start this prompt. Check the model and provider settings.",
    );
  });

  it("ignores a malformed pending send in storage", async () => {
    localStorage.setItem("pap.pending.sess-1", "{not json");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const container = await show({ status: "idle" });
    expect(hasButton(container, "Send again")).toBe(false);
    expect(localStorage.getItem("pap.pending.sess-1")).toBeNull();
  });
});

describe("Composer editor text", () => {
  it("replaces the text when an extension sets it", async () => {
    const container = await show({ status: "idle" });
    await typeInto(field(container, "Message"), "mine");
    await emit({ kind: "editor_text", text: "from the extension" });
    expect(field(container, "Message").value).toBe("from the extension");
    expect(localStorage.getItem("pap.draft.sess-1")).toBe("from the extension");
  });

  it("applies the same text again when the extension sends it again", async () => {
    const container = await show({ status: "idle" });
    await emit({ kind: "editor_text", text: "same" });
    await typeInto(field(container, "Message"), "changed");
    await emit({ kind: "editor_text", text: "same" });
    expect(field(container, "Message").value).toBe("same");
  });

  it("keeps the restored draft when the screen comes back with an editor text it already applied (M2-RT-10)", async () => {
    await show({ status: "idle" });
    await emit({ kind: "editor_text", text: "from the extension" });
    await remount();
    localStorage.setItem("pap.draft.sess-1", "my new draft");
    const container = await remount();
    expect(field(container, "Message").value).toBe("my new draft");
  });
});

describe("Composer storage", () => {
  it("keeps working when storage refuses writes, and says so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const container = await show({ status: "idle" });
    await typeInto(field(container, "Message"), "a");
    await typeInto(field(container, "Message"), "ab");
    expect(field(container, "Message").value).toBe("ab");
    await click(button(container, "Send"));
    await settle();
    expect(screen.bed.called("sessions.prompt")).toHaveLength(1);
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("drafts cannot be saved"))).toHaveLength(
      1,
    );
  });
});

describe("Composer Tab", () => {
  const tab = async (onTabToPanel?: () => boolean, init: KeyboardEventInit = {}) => {
    const container = await remount(
      <Composer sessionId="sess-1" view={EMPTY_VIEW} onTabToPanel={onTabToPanel} />,
    );
    return press(field(container, "Message"), { key: "Tab", ...init });
  };

  it("leaves Tab to the browser unless the panel hook takes it", async () => {
    expect((await tab()).defaultPrevented).toBe(false);
    expect((await tab(() => false)).defaultPrevented).toBe(false);
    const taken = vi.fn(() => true);
    expect((await tab(taken)).defaultPrevented).toBe(true);
    expect(taken).toHaveBeenCalledTimes(1);
  });

  it("does not offer Tab to the hook with a modifier", async () => {
    const taken = vi.fn(() => true);
    expect((await tab(taken, { shiftKey: true })).defaultPrevented).toBe(false);
    expect(taken).not.toHaveBeenCalled();
  });
});

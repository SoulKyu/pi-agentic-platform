// @vitest-environment happy-dom
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { alerts, button, click, field, hasButton, settle, text, typeInto } from "../../testing/dom.ts";
import { SessionScreen } from "./SessionScreen.tsx";
import { sessionSnapshot as sessionSnapshotOf } from "../../testing/session-snapshot.ts";
import { screenBed } from "../../testing/screen-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined, navigate: vi.fn() }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: unknown }) =>
      createElement("a", { href: props.to }, props.children as never),
    useNavigate: () => current.navigate,
  };
});

const screen = screenBed(current);
const user = (entryId: string, content: string) => ({
  entryId,
  message: { role: "user", content, timestamp: Number(entryId.slice(1)) },
});
const assistant = (entryId: string) => ({
  entryId,
  message: { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 5 },
});
const withRows = { rows: [user("u1", "first question"), assistant("a2")] };
const deferred = () => {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
};
const composer = (container: HTMLElement) => field(container, "Message");

describe("fork from here", () => {
  it("is offered on user rows only", async () => {
    const container = await screen.show(withRows);
    expect(
      [...container.querySelectorAll("button")].filter((b) => b.textContent === "Fork from here"),
    ).toHaveLength(1);
    expect(
      [...container.querySelectorAll("button")].filter((b) => b.textContent === "Edit from here"),
    ).toHaveLength(1);
  });

  it("forks, stores the text as the new session's draft, and opens it", async () => {
    screen.bed.handlers["sessions.fork"] = () => ({ sessionId: "new-1", text: "first question" });
    navigateMock();
    const container = await screen.show(withRows);
    await click(button(container, "Fork from here"));
    await settle();
    expect(screen.bed.called("sessions.fork")).toEqual([
      {
        method: "sessions.fork",
        params: { sessionId: "sess-1", entryId: "u1" },
        options: { commandId: "bed-cmd-00000001" },
      },
    ]);
    expect(localStorage.getItem("pap.draft.new-1")).toBe("first question");
    expect(current.navigate).toHaveBeenCalledWith({ to: "/s/$sessionId", params: { sessionId: "new-1" } });
  });

  it("is disabled while the agent runs", async () => {
    const container = await screen.show({ ...withRows, status: "running" });
    expect(button(container, "Fork from here").disabled).toBe(true);
    expect(button(container, "Edit from here").disabled).toBe(true);
  });

  it("shows the error, stores no draft and does not navigate on a failure", async () => {
    screen.bed.handlers["sessions.fork"] = () => {
      throw new RpcError("bad_request");
    };
    navigateMock();
    const container = await screen.show(withRows);
    await click(button(container, "Fork from here"));
    await settle();
    expect(alerts(container)).toEqual(["The request is invalid."]);
    expect(current.navigate).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it("after a timeout says it may have happened, and does not fork again by itself", async () => {
    screen.bed.handlers["sessions.fork"] = () => {
      throw new RpcError("timeout");
    };
    navigateMock();
    const container = await screen.show(withRows);
    await click(button(container, "Fork from here"));
    await settle();
    expect(alerts(container)[0]).toContain("may still have gone through");
    expect(screen.bed.called("sessions.fork")).toHaveLength(1);
    expect(current.navigate).not.toHaveBeenCalled();
  });
});

function navigateMock() {
  current.navigate.mockReset();
  current.navigate.mockResolvedValue(undefined);
}

describe("edit from here", () => {
  it("navigates to the message and puts the returned text in the composer, replacing what was typed", async () => {
    screen.bed.handlers["sessions.navigate"] = () => ({ cancelled: false, editorText: "first question" });
    const container = await screen.show(withRows);
    await typeInto(composer(container), "half typed");
    await click(button(container, "Edit from here"));
    await settle();
    expect(screen.bed.called("sessions.navigate")).toEqual([
      {
        method: "sessions.navigate",
        params: { sessionId: "sess-1", targetId: "u1" },
        options: { commandId: "bed-cmd-00000001" },
      },
    ]);
    expect(composer(container).value).toBe("first question");
    expect(localStorage.getItem("pap.draft.sess-1")).toBe("first question");
  });

  it("leaves the composer alone when the navigation was cancelled", async () => {
    screen.bed.handlers["sessions.navigate"] = () => ({ cancelled: true });
    const container = await screen.show(withRows);
    await typeInto(composer(container), "kept");
    await click(button(container, "Edit from here"));
    await settle();
    expect(composer(container).value).toBe("kept");
  });

  it("is not overwritten by an editor text the screen had already applied (stale replay), but a newer one still wins", async () => {
    screen.bed.handlers["sessions.navigate"] = () => ({ cancelled: false, editorText: "edited" });
    const container = await screen.show(withRows);
    await screen.emit({ kind: "editor_text", text: "from the extension" });
    expect(composer(container).value).toBe("from the extension");
    await click(button(container, "Edit from here"));
    await settle();
    expect(composer(container).value).toBe("edited");
    // The same state arrives again (a re-subscription snapshot carries the same sequence number).
    await screen.emit({ kind: "name", name: "Renamed" });
    expect(composer(container).value).toBe("edited");
    await screen.emit({ kind: "editor_text", text: "newer from the extension" });
    expect(composer(container).value).toBe("newer from the extension");
  });

  it("replaces the text but keeps a send of unknown outcome, which stays offered and blocks Send", async () => {
    screen.bed.handlers["sessions.prompt"] = () => {
      throw new RpcError("timeout");
    };
    screen.bed.handlers["sessions.navigate"] = () => ({ cancelled: false, editorText: "first question" });
    const container = await screen.show(withRows);
    await typeInto(composer(container), "deploy");
    await click(button(container, "Send"));
    await settle();
    const pending = localStorage.getItem("pap.pending.sess-1");
    expect(pending).not.toBeNull();
    await click(button(container, "Edit from here"));
    await settle();
    expect(composer(container).value).toBe("first question");
    expect(localStorage.getItem("pap.pending.sess-1")).toBe(pending);
    expect(text(container)).toContain("The message may have been sent.");
    expect(button(container, "Send").disabled).toBe(true);
    await click(button(container, "Edit"));
    expect(composer(container).value).toBe("deploy\n\nfirst question");
  });

  it("keeps Stop reachable and the other row buttons disabled while the navigation runs", async () => {
    const reply = deferred();
    screen.bed.handlers["sessions.navigate"] = () => reply.promise;
    const container = await screen.show(withRows);
    expect(hasButton(container, "Stop")).toBe(false);
    await click(button(container, "Edit from here"));
    expect(hasButton(container, "Stop")).toBe(true);
    expect(button(container, "Edit from here").disabled).toBe(true);
    expect(button(container, "Fork from here").disabled).toBe(true);
    expect(button(container, "Compact").disabled).toBe(true);
    reply.resolve({ cancelled: false, editorText: "x" });
    await settle();
    expect(hasButton(container, "Stop")).toBe(false);
    expect(button(container, "Edit from here").disabled).toBe(false);
  });

  it("shows the error of a refused navigation", async () => {
    screen.bed.handlers["sessions.navigate"] = () => {
      throw new RpcError("session_busy");
    };
    const container = await screen.show(withRows);
    await click(button(container, "Edit from here"));
    await settle();
    expect(alerts(container)).toEqual(["The session is working. Wait for it to finish, or stop it first."]);
  });
});

describe("fork when the draft cannot be stored", () => {
  it("still opens the new session and logs the failure", async () => {
    screen.bed.handlers["sessions.fork"] = () => ({ sessionId: "new-2", text: "first question" });
    navigateMock();
    const container = await screen.show(withRows);
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await click(button(container, "Fork from here"));
      await settle();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(current.navigate).toHaveBeenCalledWith({ to: "/s/$sessionId", params: { sessionId: "new-2" } });
    } finally {
      setItem.mockRestore();
      warn.mockRestore();
    }
  });
});

describe("edit from here after a remount", () => {
  it("does not put the old edit text over what was typed since", async () => {
    screen.bed.handlers["sessions.navigate"] = () => ({ cancelled: false, editorText: "first question" });
    function Switch() {
      const [id, setId] = useState("sess-1");
      return (
        <>
          <button onClick={() => setId(id === "sess-1" ? "sess-2" : "sess-1")}>switch</button>
          <SessionScreen sessionId={id} />
        </>
      );
    }
    const container = await screen.remount(<Switch />);
    await screen.emit(sessionSnapshotOf(withRows));
    await click(button(container, "Edit from here"));
    await settle();
    expect(composer(container).value).toBe("first question");
    await typeInto(composer(container), "typed since");
    await click(button(container, "switch"));
    await click(button(container, "switch"));
    expect(composer(container).value).toBe("typed since");
  });
});

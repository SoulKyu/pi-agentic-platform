// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { clearSessionDrafts, MAX_DRAFT_CHARS } from "../../stores/drafts.ts";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { alerts, button, click, field, hasButton, press, settle, text, typeInto } from "../../testing/dom.ts";
import { screenBed } from "../../testing/screen-bed.tsx";
import { useComposer } from "./use-composer.ts";

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
const { show, remount } = screen;

/** A prompt that stays in flight until the test settles it. */
function inFlight() {
  const call: { reject(error: unknown): void; resolve(value: unknown): void } = {
    reject: () => {},
    resolve: () => {},
  };
  screen.bed.handlers["sessions.prompt"] = () =>
    new Promise((resolve, reject) => {
      call.resolve = resolve;
      call.reject = reject;
    });
  return call;
}
const keys = (prefix: string) =>
  Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "").filter((key) =>
    key.startsWith(prefix),
  );
const sendFrom = async (container: HTMLElement, message: string) => {
  await typeInto(field(container, "Message"), message);
  await click(button(container, "Send"));
  await settle();
};

describe("Composer write-ahead pending send", () => {
  it("stores the send before the call, so a reload mid-flight offers Send again with the same command id", async () => {
    inFlight();
    const container = await show({ status: "idle" });
    await sendFrom(container, "deploy");
    const first = screen.bed.called("sessions.prompt")[0];
    const stored = JSON.parse(localStorage.getItem("pap.pending.sess-1") ?? "null");
    expect(stored).toEqual({ params: first?.params, commandId: first?.options?.commandId });
    const reloaded = await remount();
    expect(text(reloaded)).toContain("The message may have been sent.");
    screen.bed.handlers["sessions.prompt"] = () => ({ disposition: "started" });
    await click(button(reloaded, "Send again"));
    await settle();
    expect(screen.bed.called("sessions.prompt")[1]?.options).toEqual(first?.options);
    expect(localStorage.getItem("pap.pending.sess-1")).toBeNull();
  });

  it("forgets it on success and on a definite refusal, keeps it on an unknown outcome", async () => {
    const call = inFlight();
    const container = await show({ status: "idle" });
    await sendFrom(container, "one");
    call.resolve({ disposition: "started" });
    await settle();
    expect(localStorage.getItem("pap.pending.sess-1")).toBeNull();
    const refused = inFlight();
    await sendFrom(container, "two");
    refused.reject(new RpcError("queue_full"));
    await settle();
    expect(localStorage.getItem("pap.pending.sess-1")).toBeNull();
    expect(field(container, "Message").value).toBe("two");
    await click(button(container, "Send"));
    await settle();
    const lost = inFlight();
    await sendFrom(container, "three");
    lost.reject(new RpcError("connection_lost"));
    await settle();
    expect(localStorage.getItem("pap.pending.sess-1")).not.toBeNull();
  });
});

describe("Composer serialized sends", () => {
  it("refuses a second send while the first is in flight, and the stored entry stays the first one's", async () => {
    const call = inFlight();
    const container = await show({ status: "running" });
    await typeInto(field(container, "Message"), "first");
    await click(button(container, "Steer"));
    await settle();
    const first = screen.bed.called("sessions.prompt")[0];
    await typeInto(field(container, "Message"), "second");
    expect([button(container, "Steer").disabled, button(container, "Follow up").disabled]).toEqual([
      true,
      true,
    ]);
    await press(field(container, "Message"), { key: "Enter", ctrlKey: true });
    expect(screen.bed.called("sessions.prompt")).toHaveLength(1);
    expect(field(container, "Message").value).toBe("second");
    expect(container.querySelector('[data-composer] [role="status"][aria-live="polite"]')?.textContent).toBe(
      "A message is being sent. Wait a moment.",
    );
    expect(JSON.parse(localStorage.getItem("pap.pending.sess-1") ?? "null").commandId).toBe(
      first?.options?.commandId,
    );
    call.resolve({ disposition: "queued" });
    await settle();
    expect(localStorage.getItem("pap.pending.sess-1")).toBeNull();
    expect(container.querySelector('[data-composer] [role="status"]')).toBeNull();
    expect(button(container, "Steer").disabled).toBe(false);
  });

  it("keeps the entry of a send whose outcome is unknown", async () => {
    const call = inFlight();
    const container = await show({ status: "idle" });
    await sendFrom(container, "first");
    const stored = localStorage.getItem("pap.pending.sess-1");
    call.reject(new RpcError("timeout"));
    await settle();
    expect(localStorage.getItem("pap.pending.sess-1")).toBe(stored);
  });
});

describe("Composer sign-out and unmount races", () => {
  it("never writes a pending send back after sign-out", async () => {
    const call = inFlight();
    const container = await show({ status: "idle" });
    await sendFrom(container, "deploy");
    clearSessionDrafts(localStorage);
    call.reject(new RpcError("connection_lost"));
    await settle();
    expect(keys("pap.")).toEqual([]);
  });

  it("never writes a refused text back as a draft after sign-out", async () => {
    const call = inFlight();
    const container = await show({ status: "idle" });
    await sendFrom(container, "deploy");
    clearSessionDrafts(localStorage);
    call.reject(new RpcError("queue_full"));
    await settle();
    expect(keys("pap.")).toEqual([]);
  });

  it("does not overwrite the draft of a newer instance with a stale merge", async () => {
    const call = inFlight();
    const container = await show({ status: "idle" });
    await sendFrom(container, "sent");
    const newer = await remount();
    await typeInto(field(newer, "Message"), "newer");
    call.reject(new RpcError("queue_full"));
    await settle();
    expect(localStorage.getItem("pap.draft.sess-1")).toBe("sent\n\nnewer");
    expect(localStorage.getItem("pap.pending.sess-1")).toBeNull();
  });
});

describe("Composer banner after a remount mid-flight (M2 #44)", () => {
  const MAY_HAVE_BEEN_SENT = "The message may have been sent.";
  const remountMidFlight = async () => {
    const call = inFlight();
    const container = await show({ status: "idle" });
    await sendFrom(container, "deploy");
    const newer = await remount();
    // The send is still in flight: its outcome is not known yet, so the banner is right.
    expect(text(newer)).toContain(MAY_HAVE_BEEN_SENT);
    return { call, newer };
  };

  it("drops the banner when the send the old screen made fails definitely", async () => {
    const { call, newer } = await remountMidFlight();
    call.reject(new RpcError("queue_full"));
    await settle();
    expect(text(newer)).not.toContain(MAY_HAVE_BEEN_SENT);
    expect(hasButton(newer, "Send again")).toBe(false);
    expect(localStorage.getItem("pap.draft.sess-1")).toBe("deploy");
    expect(localStorage.getItem("pap.pending.sess-1")).toBeNull();
  });

  it("drops the banner when the send the old screen made succeeds", async () => {
    const { call, newer } = await remountMidFlight();
    call.resolve({ disposition: "started" });
    await settle();
    expect(text(newer)).not.toContain(MAY_HAVE_BEEN_SENT);
    expect(hasButton(newer, "Send again")).toBe(false);
  });

  it("keeps the banner, and Send again, when the outcome stays unknown", async () => {
    const { call, newer } = await remountMidFlight();
    call.reject(new RpcError("timeout"));
    await settle();
    expect(text(newer)).toContain(MAY_HAVE_BEEN_SENT);
    expect(hasButton(newer, "Send again")).toBe(true);
    expect(localStorage.getItem("pap.pending.sess-1")).not.toBeNull();
  });

  it("shows no banner on a remount after a definite failure", async () => {
    const call = inFlight();
    const container = await show({ status: "idle" });
    await sendFrom(container, "deploy");
    call.reject(new RpcError("queue_full"));
    await settle();
    expect(text(await remount())).not.toContain(MAY_HAVE_BEEN_SENT);
  });

  it("shows the banner on a remount after an unknown outcome", async () => {
    const call = inFlight();
    const container = await show({ status: "idle" });
    await sendFrom(container, "deploy");
    call.reject(new RpcError("connection_lost"));
    await settle();
    expect(text(await remount())).toContain(MAY_HAVE_BEEN_SENT);
  });
});

describe("Composer input cap", () => {
  it("keeps what is shown, stored and sent at the draft cap", async () => {
    const container = await show({ status: "idle" });
    await typeInto(field(container, "Message"), "x".repeat(MAX_DRAFT_CHARS + 10));
    expect(field(container, "Message").value).toHaveLength(MAX_DRAFT_CHARS);
    expect(localStorage.getItem("pap.draft.sess-1")).toHaveLength(MAX_DRAFT_CHARS);
    await click(button(container, "Send"));
    await settle();
    const sent = screen.bed.called("sessions.prompt")[0]?.params as { text: string };
    expect(sent.text).toHaveLength(MAX_DRAFT_CHARS);
  });
});

describe("Composer resend guard", () => {
  function Probe() {
    const composer = useComposer("sess-1", EMPTY_VIEW);
    return (
      <button
        type="button"
        onClick={() => {
          void composer.sendAgain();
          void composer.sendAgain();
        }}
      >
        go
      </button>
    );
  }

  it("sends a pending message once when asked twice before the screen has re-rendered", async () => {
    localStorage.setItem(
      "pap.pending.sess-1",
      JSON.stringify({
        params: { sessionId: "sess-1", text: "deploy", streamingBehavior: "steer" },
        commandId: "c-kept",
      }),
    );
    inFlight();
    const container = await remount(<Probe />);
    await click(button(container, "go"));
    await settle();
    expect(screen.bed.called("sessions.prompt")).toHaveLength(1);
  });
});

describe("Composer feedback when a send is refused locally", () => {
  const ctrlEnter = (container: HTMLElement) =>
    press(field(container, "Message"), { key: "Enter", ctrlKey: true });
  const statusText = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-composer] [role="status"][aria-live="polite"]')].map(
      (node) => node.textContent,
    );

  it("says why when Ctrl+Enter meets a pending send", async () => {
    localStorage.setItem(
      "pap.pending.sess-1",
      JSON.stringify({
        params: { sessionId: "sess-1", text: "deploy", streamingBehavior: "steer" },
        commandId: "c-kept",
      }),
    );
    const container = await show({ status: "idle" });
    await typeInto(field(container, "Message"), "next");
    expect(statusText(container)).not.toContain("Send the earlier message again, or edit it, first.");
    await ctrlEnter(container);
    expect(statusText(container)).toContain("Send the earlier message again, or edit it, first.");
    expect(screen.bed.called("sessions.prompt")).toEqual([]);
    expect(hasButton(container, "Send again")).toBe(true);
  });

  it("says why while the session compacts, and stops saying it afterwards", async () => {
    const container = await show({ status: "idle", activity: { compacting: true, retry: null } });
    await typeInto(field(container, "Message"), "next");
    await ctrlEnter(container);
    expect(statusText(container)).toContain("The session is compacting. Try again when it is done.");
    await screen.emit({ kind: "activity", activity: { compacting: false, retry: null } });
    expect(statusText(container).join("")).toBe("");
  });
});

describe("Composer truncated queue", () => {
  it("tells that some queued text could not be restored, after Stop and after Clear", async () => {
    screen.bed.handlers["sessions.clearQueue"] = () => ({
      steering: ["kept"],
      followUp: [],
      truncated: true,
    });
    const container = await show({
      status: "running",
      queue: { steering: ["kept"], followUp: [], count: 2, bytes: 4 },
    });
    await click(button(container, "Stop"));
    await settle();
    expect(field(container, "Message").value).toBe("kept");
    expect(text(container)).toContain("Some queued text could not be restored.");
    expect(alerts(container)).toEqual([]);
    const again = await show({
      status: "running",
      queue: { steering: ["kept"], followUp: [], count: 2, bytes: 4 },
    });
    expect(text(again)).not.toContain("Some queued text could not be restored.");
    await click(button(again, "Clear"));
    await settle();
    expect(text(again)).toContain("Some queued text could not be restored.");
  });
});

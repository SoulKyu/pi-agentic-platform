// @vitest-environment happy-dom
// The session chunk registers these strings when it loads; the component is rendered here without it.
import "./register-session-catalog.ts";
import type { AttachmentView } from "@pap/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { UploadError } from "../../runtime/upload.ts";
import { alerts, button, click, field, press, settle, text, typeInto } from "../../testing/dom.ts";
import { screenBed } from "../../testing/screen-bed.tsx";

const current = vi.hoisted(() => ({
  runtime: undefined as Runtime | undefined,
  uploads: [] as Array<{
    name: string;
    resolve(view: unknown): void;
    reject(failure: unknown): void;
    signal: AbortSignal;
  }>,
  timers: new Map<number, () => void>(),
}));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
  windowTimers: {
    set: (fn: () => void) => {
      const id = current.timers.size + 1;
      current.timers.set(id, fn);
      return id;
    },
    clear: (id: number) => void current.timers.delete(id),
  },
}));
vi.mock("../../runtime/upload.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/upload.ts")>()),
  uploadAttachment: (_session: string, file: File, signal: AbortSignal) =>
    new Promise<AttachmentView>((resolve, reject) => {
      current.uploads.push({
        name: file.name,
        resolve: resolve as (view: unknown) => void,
        reject,
        signal,
      });
    }),
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
const { show } = screen;
const ID = "a".repeat(22);

beforeEach(() => {
  current.uploads = [];
  current.timers.clear();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:t/1");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function transferOf(files: File[], extra: Record<string, string> = {}) {
  return {
    types: [...(files.length ? ["Files"] : []), ...Object.keys(extra)],
    files,
    items: files.map((f) => ({
      kind: "file",
      getAsFile: () => f,
      webkitGetAsEntry: () => ({ isDirectory: false }),
    })),
    getData: (type: string) => extra[type] ?? "",
  };
}
async function dropOn(target: Element, transfer: object) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: transfer });
  await act(async () => {
    target.dispatchEvent(event);
  });
}
async function finishUpload(index: number, kind: "image" | "file" = "image", id = ID) {
  const upload = current.uploads[index];
  await act(async () =>
    upload?.resolve({
      id,
      name: upload.name,
      size: 4,
      kind,
      mimeType: kind === "image" ? "image/png" : null,
    }),
  );
}
const png = () => new File(["x"], "shot.png", { type: "image/png" });

describe("Composer attachments", () => {
  it("keeps Send off while an upload runs, then sends the ids with an empty text and clears the tray", async () => {
    const container = await show({ status: "idle" });
    await dropOn(field(container, "Message"), transferOf([png()]));
    expect(text(container)).toContain("Uploading…");
    expect(button(container, "Send").disabled).toBe(true);
    await finishUpload(0);
    expect(button(container, "Send").disabled).toBe(false);
    await click(button(container, "Send"));
    await settle();
    expect(screen.bed.called("sessions.prompt")[0]?.params).toEqual({
      sessionId: "sess-1",
      text: "",
      streamingBehavior: "steer",
      attachments: [ID],
    });
    expect(container.querySelector("[data-attachment-tray]")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:t/1");
  });

  it("does not send typed text while a file is still uploading, by button or by Ctrl+Enter", async () => {
    const container = await show({ status: "idle" });
    await typeInto(field(container, "Message"), "look");
    await dropOn(field(container, "Message"), transferOf([png()]));
    expect(button(container, "Send").disabled).toBe(true);
    await press(field(container, "Message"), { key: "Enter", ctrlKey: true });
    await settle();
    expect(screen.bed.called("sessions.prompt")).toEqual([]);
    await finishUpload(0);
    expect(button(container, "Send").disabled).toBe(false);
  });

  it("sends nothing while a chip has failed, says why, and goes once it is removed", async () => {
    const container = await show({ status: "idle" });
    await typeInto(field(container, "Message"), "look");
    await dropOn(field(container, "Message"), transferOf([png()]));
    await act(async () => current.uploads[0]?.reject(new UploadError("interrupted")));
    await press(field(container, "Message"), { key: "Enter", ctrlKey: true });
    await settle();
    expect(screen.bed.called("sessions.prompt")).toEqual([]);
    expect(text(container)).toContain(
      "Wait for the files to upload, and retry or remove the ones that failed.",
    );
    await click(button(container, "Remove shot.png"));
    expect(text(container)).not.toContain("Wait for the files to upload");
    await click(button(container, "Send"));
    await settle();
    expect(screen.bed.called("sessions.prompt")).toHaveLength(1);
  });

  it("clears only the files the message carried when another was added while it was in flight", async () => {
    let answer: (value: unknown) => void = () => {};
    screen.bed.handlers["sessions.prompt"] = () => new Promise((resolve) => (answer = resolve));
    const container = await show({ status: "idle" });
    await dropOn(field(container, "Message"), transferOf([png()]));
    await finishUpload(0);
    await click(button(container, "Send"));
    await dropOn(
      field(container, "Message"),
      transferOf([new File(["y"], "later.pdf", { type: "application/pdf" })]),
    );
    await finishUpload(1, "file", "b".repeat(22));
    await act(async () => answer({ disposition: "started" }));
    await settle();
    const names = [...container.querySelectorAll("[data-attachment-tray] li")].map((li) => li.textContent);
    expect(names).toHaveLength(1);
    expect(names[0]).toContain("later.pdf");
  });

  it("uploads the tray again for fresh ids when Edit follows an unknown outcome", async () => {
    screen.bed.handlers["sessions.prompt"] = () => {
      throw new RpcError("timeout");
    };
    const container = await show({ status: "idle" });
    await dropOn(field(container, "Message"), transferOf([png()]));
    await finishUpload(0);
    await typeInto(field(container, "Message"), "see");
    await click(button(container, "Send"));
    await settle();
    await click(button(container, "Edit"));
    expect(current.uploads).toHaveLength(2);
    expect(button(container, "Send").disabled).toBe(true);
    const fresh = "c".repeat(22);
    await finishUpload(1, "image", fresh);
    screen.bed.handlers["sessions.prompt"] = () => ({ disposition: "started" });
    await click(button(container, "Send"));
    await settle();
    expect(
      (screen.bed.called("sessions.prompt")[1]?.params as { attachments: string[] }).attachments,
    ).toEqual([fresh]);
  });

  it("keeps the browser from opening a file dropped outside the field, and a text drag alone", async () => {
    const container = await show({ status: "idle" });
    const dropAt = async (target: Element, types: string[]) => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { types, files: [], items: [] } });
      await act(async () => {
        target.dispatchEvent(event);
      });
      return event;
    };
    expect((await dropAt(button(container, "Send"), ["Files"])).defaultPrevented).toBe(true);
    expect((await dropAt(document.body, ["text/plain"])).defaultPrevented).toBe(false);
    await screen.remount(<></>);
    expect((await dropAt(document.body, ["Files"])).defaultPrevented).toBe(false);
  });

  it("keeps the tray and the text when the send is refused", async () => {
    screen.bed.handlers["sessions.prompt"] = () => {
      throw new RpcError("queue_full");
    };
    const container = await show({ status: "idle" });
    await dropOn(field(container, "Message"), transferOf([png()]));
    await finishUpload(0);
    await typeInto(field(container, "Message"), "look");
    await click(button(container, "Send"));
    await settle();
    expect(container.querySelector("[data-attachment-tray]")).not.toBeNull();
    expect(field(container, "Message").value).toBe("look");
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("explains a rejected prompt that carried an image", async () => {
    screen.bed.handlers["sessions.prompt"] = () => {
      throw new RpcError("prompt_rejected");
    };
    const container = await show({ status: "idle" });
    await dropOn(field(container, "Message"), transferOf([png()]));
    await finishUpload(0);
    await click(button(container, "Send"));
    await settle();
    expect(alerts(container)).toContain(
      "The message was not sent: an image could not be read, or this model cannot take images. Remove it and try again.",
    );
    expect(container.querySelector("[data-attachment-tray]")).not.toBeNull();
  });

  it("sends again with the same command id and ids after an unknown outcome, and keeps the tray until it lands", async () => {
    screen.bed.handlers["sessions.prompt"] = () => {
      throw new RpcError("timeout");
    };
    const container = await show({ status: "idle" });
    await dropOn(field(container, "Message"), transferOf([png()]));
    await finishUpload(0);
    await click(button(container, "Send"));
    await settle();
    expect(JSON.parse(localStorage.getItem("pap.pending.sess-1") ?? "{}").params.attachments).toEqual([ID]);
    screen.bed.handlers["sessions.prompt"] = () => ({ disposition: "started" });
    await click(button(container, "Send again"));
    await settle();
    const [first, second] = screen.bed.called("sessions.prompt");
    expect(second?.options?.commandId).toBe(first?.options?.commandId);
    expect(second?.params).toEqual(first?.params);
    expect((second?.params as { attachments?: string[] }).attachments).toEqual([ID]);
    expect(container.querySelector("[data-attachment-tray]")).toBeNull();
  });

  it("says the files expired when the resend finds them gone, and puts the text back", async () => {
    screen.bed.handlers["sessions.prompt"] = () => {
      throw new RpcError("timeout");
    };
    const container = await show({ status: "idle" });
    await dropOn(field(container, "Message"), transferOf([png()]));
    await finishUpload(0);
    await typeInto(field(container, "Message"), "see this");
    await click(button(container, "Send"));
    await settle();
    screen.bed.handlers["sessions.prompt"] = () => {
      throw new RpcError("not_found");
    };
    await click(button(container, "Send again"));
    await settle();
    expect(alerts(container)).toContain("The attached files expired. Attach them again.");
    expect(field(container, "Message").value).toBe("see this");
    expect(container.querySelector("[data-attachment-tray]")).toBeNull();
    expect(localStorage.getItem("pap.pending.sess-1")).toBeNull();
  });

  it("inserts a mention for an explorer row dropped on the field", async () => {
    const container = await show({ status: "idle", cwd: "/w/app" });
    await typeInto(field(container, "Message"), "read");
    await dropOn(field(container, "Message"), transferOf([], { "application/x-pap-path": "/w/lib/x.ts" }));
    expect(field(container, "Message").value).toBe("read @../lib/x.ts ");
    expect(current.uploads).toEqual([]);
  });

  it("aborts what runs and revokes the previews when the screen goes away", async () => {
    const container = await show({ status: "idle" });
    await dropOn(field(container, "Message"), transferOf([png()]));
    await screen.remount(<></>);
    expect(current.uploads[0]?.signal.aborted).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:t/1");
    expect(container.isConnected).toBe(false);
  });
});

describe("Composer one key path", () => {
  async function openMenu() {
    screen.bed.handlers["files.search"] = () => ({ paths: ["a.ts", "b.ts"], truncated: false });
    const container = await show({ status: "idle", cwd: "/w" });
    await typeInto(field(container, "Message"), "see @a");
    await act(async () => [...current.timers.values()].forEach((fire) => fire()));
    await settle();
    return container;
  }

  it("sends nothing on Enter, Tab or Escape while a menu is open, and takes the key itself", async () => {
    const container = await openMenu();
    const area = field(container, "Message");
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    await press(area, { key: "ArrowDown" });
    await press(area, { key: "Enter" });
    expect(area.value).toBe("see @b.ts ");
    expect(screen.bed.called("sessions.prompt")).toEqual([]);
    await typeInto(area, "see @a");
    await act(async () => [...current.timers.values()].forEach((fire) => fire()));
    await settle();
    const escape = await press(area, { key: "Escape" });
    expect(escape.defaultPrevented).toBe(true);
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(screen.bed.called("sessions.prompt")).toEqual([]);
  });

  it("does not send on Ctrl+Enter while a menu is open and an input method is composing", async () => {
    const container = await openMenu();
    await press(field(container, "Message"), { key: "Enter", ctrlKey: true, isComposing: true });
    expect(screen.bed.called("sessions.prompt")).toEqual([]);
  });

  it("sends on Ctrl+Enter once the menu is closed", async () => {
    const container = await openMenu();
    const area = field(container, "Message");
    await press(area, { key: "Escape" });
    await press(area, { key: "Enter", ctrlKey: true });
    await settle();
    expect(screen.bed.called("sessions.prompt")).toHaveLength(1);
  });
});

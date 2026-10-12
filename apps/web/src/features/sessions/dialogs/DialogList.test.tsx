// @vitest-environment happy-dom
import type { Dialog } from "@pap/contracts";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../../runtime/index.ts";
import {
  button,
  click,
  field,
  mount,
  press,
  settle,
  text,
  typeInto,
  type Mounted,
} from "../../../testing/dom.ts";
import { fakeRuntime } from "../../../testing/runtime-bed.ts";
import { DialogList } from "./DialogList.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
let mounted: Mounted | null = null;

async function show(dialogs: readonly Dialog[], hidden = 0) {
  mounted = await mount(<DialogList sessionId="sess-1" dialogs={dialogs} hidden={hidden} />);
  await settle();
  return mounted.container;
}
const sent = () => bed.called("sessions.respondDialog").map((call) => call.params);
const reply = (dialogId: string, response: unknown) => ({ sessionId: "sess-1", dialogId, response });
const select: Dialog = { id: "s1", method: "select", title: "Pick one", options: ["a", "b", "c"] };

beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

describe("select", () => {
  it("sends the option clicked, and Cancel sends cancelled", async () => {
    const page = await show([select]);
    expect([...page.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["a", "b", "c", "Cancel"]);
    await click(button(page, "b"));
    await click(button(page, "a"));
    await settle();
    expect(sent()).toEqual([reply("s1", { value: "b" })]);
  });

  it("Cancel sends { cancelled: true }", async () => {
    const page = await show([select]);
    await click(button(page, "Cancel"));
    await settle();
    expect(sent()).toEqual([reply("s1", { cancelled: true })]);
  });

  it("is a labelled group that does not look like an approval", async () => {
    const page = await show([select]);
    const group = page.querySelector('[role="group"]');
    expect(group?.getAttribute("aria-labelledby")).toBe(page.querySelector("h3")?.id);
    expect(page.querySelector('[role="alertdialog"]')).toBeNull();
    expect(text(page)).not.toContain("Approval");
  });

  it("shows option labels as text and clips a very long one", async () => {
    const page = await show([{ ...select, options: ["<i>x</i>", "y".repeat(4000)] }]);
    expect(page.querySelector("i")).toBeNull();
    expect(text(page)).toContain("<i>x</i>");
    expect(text(page).length).toBeLessThan(1000);
  });

  it("re-arms the card after a refused answer", async () => {
    bed.handlers["sessions.respondDialog"] = () => {
      throw new RpcError("bad_request");
    };
    const page = await show([select]);
    await click(button(page, "b"));
    await settle();
    expect(button(page, "b").disabled).toBe(false);
    expect(button(page, "Cancel").disabled).toBe(false);
  });
});

describe("input and editor", () => {
  it("input shows its placeholder, sends the typed value on Submit and on Enter, once", async () => {
    const page = await show([{ id: "i1", method: "input", title: "Your name", placeholder: "Ada" }]);
    const input = field(page, "Your name") as HTMLInputElement;
    expect(input.placeholder).toBe("Ada");
    expect(input.tagName).toBe("INPUT");
    await typeInto(input, "Grace");
    const event = await press(input, { key: "Enter" });
    expect(event.defaultPrevented).toBe(true);
    await settle();
    expect(sent()).toEqual([reply("i1", { value: "Grace" })]);
    await click(button(page, "Submit"));
    await settle();
    expect(sent()).toEqual([reply("i1", { value: "Grace" })]);
  });

  it("input Cancel sends cancelled", async () => {
    const page = await show([{ id: "i1", method: "input", title: "Your name" }]);
    await click(button(page, "Cancel"));
    await settle();
    expect(sent()).toEqual([reply("i1", { cancelled: true })]);
  });

  it("editor starts with its prefill; Enter types a newline, Ctrl+Enter and Cmd+Enter submit", async () => {
    const dialogs: Dialog[] = [{ id: "e1", method: "editor", title: "Edit", prefill: "line one\nline two" }];
    const page = await show(dialogs);
    const editor = field(page, "Edit");
    expect(editor.tagName).toBe("TEXTAREA");
    expect(editor.value).toBe("line one\nline two");
    const plain = await press(editor, { key: "Enter" });
    expect(plain.defaultPrevented).toBe(false);
    expect(sent()).toEqual([]);
    await typeInto(editor, "changed");
    await press(editor, { key: "Enter", ctrlKey: true });
    await press(editor, { key: "Enter", metaKey: true });
    await settle();
    expect(sent()).toEqual([reply("e1", { value: "changed" })]);
  });

  it("an editor prefill is shown without bidi or control characters", async () => {
    const page = await show([{ id: "e1", method: "editor", title: "Edit", prefill: "a‮b\u0007c\td" }]);
    expect(field(page, "Edit").value).toBe("abc\td");
  });

  it("re-arms the editor after a refused answer and keeps what was typed", async () => {
    bed.handlers["sessions.respondDialog"] = () => {
      throw new RpcError("worker_failed");
    };
    const page = await show([{ id: "e1", method: "editor", title: "Edit", prefill: "x" }]);
    await typeInto(field(page, "Edit"), "my text");
    await click(button(page, "Submit"));
    await settle();
    expect(button(page, "Submit").disabled).toBe(false);
    expect(field(page, "Edit").value).toBe("my text");
  });
});

describe("extension confirm", () => {
  const confirm: Dialog = { id: "c1", method: "confirm", title: "Delete it?", message: "really" };

  it("sends confirmed true or false and never looks like an approval", async () => {
    const page = await show([confirm]);
    expect([...page.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Yes", "No"]);
    expect(page.querySelector('[role="alertdialog"]')).toBeNull();
    expect(text(page)).not.toContain("Approval");
    await click(button(page, "No"));
    await click(button(page, "Yes"));
    await settle();
    expect(sent()).toEqual([reply("c1", { confirmed: false })]);
  });

  it("an extension whose title says Approval gets no approval header or tint", async () => {
    const page = await show([{ ...confirm, title: "Approval · exec" }]);
    expect(page.querySelector("[data-approval-header]")).toBeNull();
    expect(page.innerHTML).not.toContain("bg-attention-tint");
  });
});

describe("the list", () => {
  it("renders every open dialog, oldest first, each answered on its own", async () => {
    const page = await show([
      { id: "x1", method: "select", title: "First", options: ["opt"] },
      { id: "x2", method: "confirm", title: "Second" },
    ]);
    expect([...page.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["First", "Second"]);
    await click(button(page, "Yes"));
    await settle();
    expect(sent()).toEqual([reply("x2", { confirmed: true })]);
    expect(button(page, "opt").disabled).toBe(false);
  });

  it("shows the static timeout line for a dialog that has one", async () => {
    const page = await show([{ ...select, timeout: 5000 }]);
    expect(text(page)).toContain("Closes on its own after 5 s");
  });

  it("says how many more dialogs are waiting", async () => {
    expect(text(await show([], 3))).toBe("3 more dialogs are waiting");
    await mounted?.unmount();
    expect(text(await show([], 1))).toBe("1 more dialog is waiting");
    await mounted?.unmount();
    expect(text(await show([], 0))).toBe("");
  });

  it("clips a 64 KB message and expands it on request, as text", async () => {
    const message = `<script>x</script>${"m".repeat(65_000)}`;
    const page = await show([{ ...select, message }]);
    expect(page.querySelector("script")).toBeNull();
    expect(text(page).length).toBeLessThan(5000);
    await click(button(page, "Show more"));
    expect(page.querySelector("[data-clipped]")?.textContent).toBe(message);
  });

  it("clips a long title to a few characters more than the limit", async () => {
    const page = await show([{ ...select, title: "t".repeat(4096) }]);
    expect((page.querySelector("h3")?.textContent ?? "").length).toBeLessThan(400);
  });

  it("answers once even when the answer is clicked twice before React re-renders", async () => {
    const page = await show([select]);
    const b = button(page, "b");
    b.click();
    button(page, "c").click();
    await settle();
    expect(sent()).toEqual([reply("s1", { value: "b" })]);
  });

  it("a refused answer sends a fresh command id; a retry after an unknown outcome reuses the first", async () => {
    let attempts = 0;
    bed.handlers["sessions.respondDialog"] = () => {
      attempts += 1;
      if (attempts === 1) throw new RpcError("bad_request");
      if (attempts === 2) throw new RpcError("timeout");
      return { ok: true };
    };
    const page = await show([select]);
    await click(button(page, "a"));
    await settle();
    await click(button(page, "b"));
    await settle();
    expect(button(page, "b").disabled).toBe(true);
    expect(page.querySelector('[role="status"]')?.textContent).toContain(
      "The session did not answer in time",
    );
    expect(page.querySelector('[role="alert"]')).toBeNull();
    await click(button(page, "Send again"));
    await settle();
    const calls = bed.called("sessions.respondDialog");
    expect(calls.map((call) => (call.params as { response: unknown }).response)).toEqual([
      { value: "a" },
      { value: "b" },
      { value: "b" },
    ]);
    const ids = calls.map((call) => call.options?.commandId);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[2]).toBe(ids[1]);
  });

  it("forgets the retry of a dialog that has closed", async () => {
    bed.handlers["sessions.respondDialog"] = () => {
      throw new RpcError("connection_lost");
    };
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(!open)}>toggle</button>
          <DialogList sessionId="sess-1" dialogs={open ? [select] : []} hidden={0} />
        </>
      );
    }
    mounted = await mount(<Harness />);
    const page = mounted.container;
    await click(button(page, "a"));
    await settle();
    expect(text(page)).toContain("Send again");
    await click(button(page, "toggle"));
    expect(text(page)).not.toContain("Send again");
    await click(button(page, "toggle"));
    expect(text(page)).not.toContain("Send again");
    expect(button(page, "a").disabled).toBe(false);
  });
});

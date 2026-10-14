// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n/register-files.ts";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { alerts, button, click, hasButton, press, settle, text } from "../../testing/dom.ts";
import { mockEditor } from "./editor-mock.ts";
import { meta } from "./files-bed.ts";
import {
  ETAG_1,
  ETAG_2,
  ETAG_3,
  diskOf,
  editor,
  open,
  reads,
  resetWorld,
  save,
  show,
  stepUpAsk,
  type,
  world,
  writeParams,
  writes,
} from "./edit-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@pap/ui/code", async () => (await import("./editor-mock.ts")).mockCodeModule());

beforeEach(() => resetWorld((runtime) => (current.runtime = runtime)));
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("editing", () => {
  it("offers the editor when the file is editable and whole, a read-only view otherwise", async () => {
    const c = await show();
    await open(c, "a.ts");
    expect(editor(c).dataset.readonly).toBe("false");
    expect(hasButton(c, "Save")).toBe(true);
    diskOf("/p/b.ts").patch = { editable: false };
    await open(c, "b.ts");
    expect(editor(c).dataset.readonly).toBe("true");
    expect(hasButton(c, "Save")).toBe(false);
  });

  it("saves with the base etag and a command id, then is clean and keeps the new etag", async () => {
    const c = await show();
    await open(c, "a.ts");
    expect(button(c, "Save").disabled).toBe(true);
    await type(c, "one");
    expect(button(c, "Save").disabled).toBe(false);
    await save(c);
    expect(writeParams()).toEqual({ path: "/p/a.ts", text: "one", baseEtag: ETAG_1 });
    expect(writes()[0]?.options?.commandId).toMatch(/^bed-cmd-/);
    expect(button(c, "Save").disabled).toBe(true);
    expect(text(c)).toContain("Saved");
    await type(c, "two");
    await save(c);
    expect(writeParams(1)).toEqual({ path: "/p/a.ts", text: "two", baseEtag: ETAG_2 });
  });

  it("Mod-s in the editor saves", async () => {
    const c = await show();
    await open(c, "a.ts");
    await type(c, "keys");
    await press(editor(c), { key: "s", ctrlKey: true });
    await settle();
    expect(writeParams()).toEqual({ path: "/p/a.ts", text: "keys", baseEtag: ETAG_1 });
  });

  it("sends one write when Mod-s is pressed again while the first is on its way", async () => {
    let answer: (value: unknown) => void = () => {};
    world.bed.handlers["files.write"] = () => new Promise((resolve) => (answer = resolve));
    const c = await show();
    await open(c, "a.ts");
    await type(c, "once");
    await press(editor(c), { key: "s", ctrlKey: true });
    await press(editor(c), { key: "s", ctrlKey: true });
    expect(writes()).toHaveLength(1);
    expect(editor(c).dataset.readonly).toBe("true");
    answer({ meta: meta("/p/a.ts", { etag: ETAG_2 }) });
    await settle();
    expect(text(c)).toContain("Saved");
  });

  it("Mod-s saves the text the editor passes, not a draft one keystroke behind", async () => {
    const c = await show();
    await open(c, "a.ts");
    const props = mockEditor.latest;
    // CodeMirror calls both in the same tick, before React has committed the edit.
    await act(async () => {
      props?.onChange?.("last keystroke");
      props?.onSave?.("last keystroke");
    });
    await settle();
    expect(writes()).toHaveLength(1);
    expect(writeParams()).toEqual({ path: "/p/a.ts", text: "last keystroke", baseEtag: ETAG_1 });
  });

  it("a second save of the same file cannot start after the tab was left and reopened mid-save", async () => {
    let answer: (value: unknown) => void = () => {};
    world.bed.handlers["files.write"] = () => new Promise((resolve) => (answer = resolve));
    const c = await show();
    await open(c, "a.ts");
    await type(c, "once");
    await press(editor(c), { key: "s", ctrlKey: true });
    expect(writes()).toHaveLength(1);
    await open(c, "b.ts");
    await click(c.querySelector('[role="tab"]') as HTMLElement);
    await settle();
    expect(editor(c).value).toBe("once");
    await press(editor(c), { key: "s", ctrlKey: true });
    await settle();
    expect(writes()).toHaveLength(1);
    answer({ meta: meta("/p/a.ts", { etag: ETAG_2 }) });
    await settle();
  });

  describe("a stale save", () => {
    const stale = () => {
      world.bed.handlers["files.write"] = () => {
        throw new RpcError("conflict");
      };
    };

    it("never overwrites silently: a banner, the edit kept", async () => {
      stale();
      const c = await show();
      await open(c, "a.ts");
      await type(c, "mine");
      await save(c);
      expect(text(c)).toContain("Changed on disk since you opened it");
      expect(editor(c).value).toBe("mine");
      expect(writes()).toHaveLength(1);
    });

    it("Overwrite reads the current etag, then writes with it and says the other change is lost", async () => {
      stale();
      const c = await show();
      await open(c, "a.ts");
      await type(c, "mine");
      await save(c);
      expect(text(c)).toContain("the other change is lost");
      Object.assign(diskOf("/p/a.ts"), { etag: ETAG_3, text: "theirs" });
      world.bed.handlers["files.write"] = (params) => {
        void params;
        return { meta: meta("/p/a.ts", { etag: ETAG_2 }) };
      };
      const readsBefore = reads().length;
      await click(button(c, "Overwrite"));
      await settle();
      expect(reads().length).toBe(readsBefore + 1);
      expect(writeParams(1)).toEqual({ path: "/p/a.ts", text: "mine", baseEtag: ETAG_3 });
      expect(text(c)).not.toContain("Changed on disk");
      expect(button(c, "Save").disabled).toBe(true);
    });

    it("Overwrite then Cancel on Save anyway? keeps the stale banner", async () => {
      let first = true;
      world.bed.handlers["files.write"] = () => {
        if (first) {
          first = false;
          throw new RpcError("conflict");
        }
        throw new RpcError("protected_path");
      };
      const c = await show();
      await open(c, "a.ts");
      await type(c, "mine");
      await save(c);
      await click(button(c, "Overwrite"));
      await settle();
      expect(text(c)).toContain("Save anyway?");
      await click(button(c, "Cancel"));
      expect(text(c)).toContain("Changed on disk since you opened it");
      expect(hasButton(c, "Overwrite")).toBe(true);
    });

    it("Reload asks first, then drops the edit and shows the disk", async () => {
      stale();
      const c = await show();
      await open(c, "a.ts");
      await type(c, "mine");
      await save(c);
      Object.assign(diskOf("/p/a.ts"), { etag: ETAG_3, text: "theirs" });
      await click(button(c, "Reload"));
      expect(text(c)).toContain("Drop your edit and reload the file?");
      expect(editor(c).value).toBe("mine");
      await click(button(c, "Cancel"));
      expect(editor(c).value).toBe("mine");
      await click(button(c, "Reload"));
      await click(button(c, "Drop my edit"));
      await settle();
      expect(editor(c).value).toBe("theirs");
      expect(button(c, "Save").disabled).toBe(true);
    });
  });

  describe("protected files", () => {
    const refuseUnconfirmed = () => {
      world.bed.handlers["files.write"] = (params) => {
        if (!(params as { confirmProtected?: true }).confirmProtected) throw new RpcError("protected_path");
        return { meta: meta("/p/a.ts", { etag: ETAG_2 }) };
      };
    };

    it("a protected_path answer becomes the ask; Save resends with confirmProtected and the same text", async () => {
      refuseUnconfirmed();
      const c = await show();
      await open(c, "a.ts");
      await type(c, "hook");
      await save(c);
      expect(text(c)).toContain(
        "This file can run commands later (a git hook, an editor task or a shell setting). Save anyway?",
      );
      await click(button(c, "Save"));
      await settle();
      expect(writeParams(1)).toEqual({
        path: "/p/a.ts",
        text: "hook",
        baseEtag: ETAG_1,
        confirmProtected: true,
      });
      expect(text(c)).toContain("Saved");
    });

    it("Cancel sends nothing more and leaves the editor dirty", async () => {
      refuseUnconfirmed();
      const c = await show();
      await open(c, "a.ts");
      await type(c, "hook");
      await save(c);
      await click(button(c, "Cancel"));
      expect(writes()).toHaveLength(1);
      expect(editor(c).value).toBe("hook");
      expect(button(c, "Save").disabled).toBe(false);
    });

    it("a file marked confirm shows the ask before any send", async () => {
      diskOf("/p/a.ts").patch = { protection: "confirm" };
      const c = await show();
      await open(c, "a.ts");
      await type(c, "x");
      await save(c);
      expect(writes()).toHaveLength(0);
      expect(text(c)).toContain("Save anyway?");
      await click(button(c, "Save"));
      await settle();
      expect(writes()).toHaveLength(1);
      expect(writeParams()).toMatchObject({ confirmProtected: true });
    });

    it("a step_up file: the ask, then one password prompt, then a resend with the same command id", async () => {
      diskOf("/p/a.ts").patch = { protection: "step_up" };
      let first = true;
      world.bed.handlers["files.write"] = () => {
        if (first) {
          first = false;
          throw new RpcError("step_up_required");
        }
        return { meta: meta("/p/a.ts", { etag: ETAG_2, protection: "step_up" }) };
      };
      const c = await show();
      await open(c, "a.ts");
      await type(c, "cfg");
      await save(c);
      expect(text(c)).toContain("This is Pi's configuration or code: pap will ask for your password.");
      expect(writes()).toHaveLength(0);
      await click(button(c, "Save"));
      await settle();
      expect(stepUpAsk).toHaveBeenCalledTimes(1);
      expect(writes()).toHaveLength(2);
      expect(writeParams(0)).toMatchObject({ confirmProtected: true, text: "cfg" });
      expect(writes()[1]?.options?.commandId).toBe(writes()[0]?.options?.commandId);
      expect(text(c)).toContain("Saved");
    });

    it("a cancelled password prompt sends nothing more and keeps the edit", async () => {
      diskOf("/p/a.ts").patch = { protection: "step_up" };
      world.bed.handlers["files.write"] = () => {
        throw new RpcError("step_up_required");
      };
      stepUpAsk.mockResolvedValue(false);
      const c = await show();
      await open(c, "a.ts");
      await type(c, "cfg");
      await save(c);
      await click(button(c, "Save"));
      await settle();
      expect(writes()).toHaveLength(1);
      expect(alerts(c)).toEqual(["Not saved: your password was not confirmed."]);
      expect(editor(c).value).toBe("cfg");
    });
  });

  describe("size", () => {
    it("says Too large to save here before sending when the encoded frame would pass 900 000 bytes", async () => {
      const c = await show();
      await open(c, "a.ts");
      await type(c, "\u0001".repeat(200 * 1024));
      await save(c);
      expect(writes()).toHaveLength(0);
      expect(alerts(c)).toEqual(["Too large to save here"]);
    });

    it("says it too when the server answers payload_too_large", async () => {
      world.bed.handlers["files.write"] = () => {
        throw new RpcError("payload_too_large");
      };
      const c = await show();
      await open(c, "a.ts");
      await type(c, "x");
      await save(c);
      expect(alerts(c)).toEqual(["Too large to save here"]);
    });
  });

  describe("a save whose outcome is unknown (timeout)", () => {
    const digestOf = (bytes: number) =>
      vi.fn(async () => new Uint8Array(32).fill(bytes).buffer as ArrayBuffer);
    const timeout = () => {
      world.bed.handlers["files.write"] = () => {
        throw new RpcError("timeout");
      };
    };

    it("re-reads and says Saved when the new etag is the SHA-256 prefix of the saved text", async () => {
      timeout();
      vi.stubGlobal("isSecureContext", true);
      vi.stubGlobal("crypto", { subtle: { digest: digestOf(0xaa) } });
      const c = await show();
      await open(c, "a.ts");
      await type(c, "maybe");
      Object.assign(diskOf("/p/a.ts"), { etag: "a".repeat(32), text: "maybe" });
      await save(c);
      expect(text(c)).toContain("Saved");
      expect(writes()).toHaveLength(1);
      expect(button(c, "Save").disabled).toBe(true);
    });

    it("warns and never resends when the etag differs", async () => {
      timeout();
      vi.stubGlobal("isSecureContext", true);
      vi.stubGlobal("crypto", { subtle: { digest: digestOf(0xbb) } });
      const c = await show();
      await open(c, "a.ts");
      await type(c, "maybe");
      Object.assign(diskOf("/p/a.ts"), { etag: "a".repeat(32) });
      await save(c);
      expect(text(c)).toContain("The save may not have completed");
      expect(hasButton(c, "Reload")).toBe(true);
      expect(writes()).toHaveLength(1);
      expect(editor(c).value).toBe("maybe");
    });

    it("warns when the page cannot hash (not a secure context)", async () => {
      timeout();
      vi.stubGlobal("isSecureContext", false);
      const c = await show();
      await open(c, "a.ts");
      await type(c, "maybe");
      await save(c);
      expect(text(c)).toContain("The save may not have completed");
      expect(writes()).toHaveLength(1);
    });
  });

  it("a failure with another code says the edit is still here", async () => {
    world.bed.handlers["files.write"] = () => {
      throw new RpcError("forbidden");
    };
    const c = await show();
    await open(c, "a.ts");
    await type(c, "x");
    await save(c);
    expect(alerts(c)).toEqual(["Could not save. Your changes are still here."]);
  });
});

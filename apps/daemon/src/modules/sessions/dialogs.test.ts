import { describe, expect, it } from "vitest";
import { createDialogRegistry, DIALOG_FRAME_BYTES } from "./dialogs.ts";

const request = (id: string, fields: Record<string, unknown> = {}) => ({
  type: "extension_ui_request" as const,
  id,
  method: "confirm",
  title: "Run a command?",
  message: "bash: ls",
  ...fields,
});
const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe("dialog registry", () => {
  it("opens known dialogs, hands each one out once, and clears", () => {
    const dialogs = createDialogRegistry();
    expect(dialogs.offer(request("d1")).kind).toBe("opened");
    expect(dialogs.list().map((d) => d.id)).toEqual(["d1"]);
    expect(dialogs.take("d1")?.id).toBe("d1");
    expect(dialogs.take("d1")).toBeNull();
    dialogs.offer(request("d2"));
    expect(dialogs.clear().map((d) => d.id)).toEqual(["d2"]);
    expect(dialogs.list()).toEqual([]);
  });

  it("sends only the dialog's own fields, whatever else the request carries", () => {
    const dialogs = createDialogRegistry();
    const verdict = dialogs.offer(request("d1", { widgetLines: ["x"], extra: { deep: true } }));
    expect(verdict).toEqual({
      kind: "opened",
      dialog: { id: "d1", method: "confirm", title: "Run a command?", message: "bash: ls" },
    });
  });

  it("cancels unknown methods and malformed dialogs, passes decorations through", () => {
    const dialogs = createDialogRegistry();
    expect(dialogs.offer(request("x", { method: "custom" }))).toEqual({
      kind: "cancel",
      reason: "unknown_method",
    });
    expect(dialogs.offer(request("y", { title: 42 }))).toEqual({ kind: "cancel", reason: "malformed" });
    expect(dialogs.offer(request("", {}))).toEqual({ kind: "cancel", reason: "malformed" });
    expect(dialogs.offer(request("z", { method: "notify", message: "hi" })).kind).toBe("decoration");
  });

  it("cancels beyond 64 open dialogs and beyond 8 MiB", () => {
    const byCount = createDialogRegistry();
    for (let i = 0; i < 64; i++) expect(byCount.offer(request(`c${i}`)).kind).toBe("opened");
    expect(byCount.offer(request("c64"))).toEqual({ kind: "cancel", reason: "limit" });
    const bySize = createDialogRegistry();
    for (let i = 0; i < 8; i++) {
      expect(bySize.offer(request(`s${i}`, { method: "editor", prefill: "x".repeat(1_000_000) })).kind).toBe(
        "opened",
      );
    }
    expect(bySize.offer(request("s8", { method: "editor", prefill: "x".repeat(1_000_000) }))).toEqual({
      kind: "cancel",
      reason: "limit",
    });
  });

  it("frees room when a dialog is answered", () => {
    const dialogs = createDialogRegistry();
    for (let i = 0; i < 64; i++) dialogs.offer(request(`c${i}`));
    dialogs.take("c0");
    expect(dialogs.offer(request("again")).kind).toBe("opened");
  });
});

describe("dialog size", () => {
  it("cuts text fields to their contract limits and marks the cut", () => {
    const dialogs = createDialogRegistry();
    const verdict = dialogs.offer(request("d1", { title: "t".repeat(5000), message: "m".repeat(70_000) }));
    if (verdict.kind !== "opened") throw new Error("expected the dialog to open");
    expect(verdict.dialog.title).toHaveLength(4096);
    expect(verdict.dialog.title.endsWith("…")).toBe(true);
    expect(verdict.dialog.message).toHaveLength(65_536);
  });

  it("keeps one dialog under the frame budget even when every character escapes to six bytes", () => {
    const dialogs = createDialogRegistry();
    const verdict = dialogs.offer(request("d1", { method: "editor", prefill: "\u0000".repeat(1_000_000) }));
    if (verdict.kind !== "opened") throw new Error("expected the dialog to open");
    expect(sizeOf(verdict.dialog)).toBeLessThanOrEqual(DIALOG_FRAME_BYTES);
    expect(verdict.dialog.prefill?.endsWith("…")).toBe(true);
    // The frame around it (subscription, epoch, sequence) fits in the 1 MiB the socket allows.
    expect(DIALOG_FRAME_BYTES + 512).toBeLessThan(1024 * 1024);
  });

  it("cuts the longest field first and leaves the others whole", () => {
    const dialogs = createDialogRegistry();
    const verdict = dialogs.offer(
      request("d1", { method: "editor", message: "m".repeat(60_000), prefill: "p".repeat(1_000_000) }),
    );
    if (verdict.kind !== "opened") throw new Error("expected the dialog to open");
    expect(verdict.dialog.message).toHaveLength(60_000);
    expect(sizeOf(verdict.dialog)).toBeLessThanOrEqual(DIALOG_FRAME_BYTES);
    expect(sizeOf(verdict.dialog)).toBeGreaterThan(DIALOG_FRAME_BYTES - 16);
  });

  it("cancels a select whose options cannot be shown whole, because the answer must match one", () => {
    const dialogs = createDialogRegistry();
    const tooMany = Array.from({ length: 101 }, (_, i) => `option ${i}`);
    expect(dialogs.offer(request("a", { method: "select", options: tooMany }))).toEqual({
      kind: "cancel",
      reason: "too_large",
    });
    expect(dialogs.offer(request("b", { method: "select", options: ["x".repeat(4097)] }))).toEqual({
      kind: "cancel",
      reason: "too_large",
    });
    expect(dialogs.offer(request("c", { method: "select", options: ["a", "b"] })).kind).toBe("opened");
  });

  it("cancels a select with options that are not text", () => {
    const dialogs = createDialogRegistry();
    expect(dialogs.offer(request("a", { method: "select", options: ["a", 2] }))).toEqual({
      kind: "cancel",
      reason: "malformed",
    });
  });

  it("keeps a timeout only when it is a positive whole number of milliseconds", () => {
    const dialogs = createDialogRegistry();
    const timeoutOf = (value: unknown) => {
      const verdict = dialogs.offer(request(`t${String(value)}`, { timeout: value }));
      return verdict.kind === "opened" ? verdict.dialog.timeout : "cancelled";
    };
    expect(timeoutOf(30_000)).toBe(30_000);
    expect(timeoutOf(1.5)).toBeUndefined();
    expect(timeoutOf(-1)).toBeUndefined();
    expect(timeoutOf("soon")).toBeUndefined();
  });
});

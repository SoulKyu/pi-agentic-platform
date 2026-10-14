import { Dialog } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { sizeOf } from "../../kernel/json-bytes.ts";
import { createDialogRegistry, DIALOG_FRAME_BYTES } from "./dialogs.ts";

const request = (id: string, fields: Record<string, unknown> = {}) => ({
  type: "extension_ui_request" as const,
  id,
  method: "confirm",
  title: "Run a command?",
  message: "bash: ls",
  ...fields,
});

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

  it("cuts a long title without splitting a surrogate pair", () => {
    const verdict = createDialogRegistry().offer(request("d1", { title: `${"a".repeat(4094)}\u{1F600}b` }));
    if (verdict.kind !== "opened") throw new Error("expected the dialog to open");
    expect(verdict.dialog.title).toBe(`${"a".repeat(4094)}…`);
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

  it("cuts text to the limits the Dialog schema declares", () => {
    const dialogs = createDialogRegistry();
    // The exact cap is pinned too, so a cap raised in the contract is noticed here and not only a lowered one.
    expect(Dialog.shape.title.maxLength).toBe(4096);
    const verdict = dialogs.offer(
      request("d", { title: "t".repeat(Number(Dialog.shape.title.maxLength) + 10) }),
    );
    expect(verdict.kind === "opened" && verdict.dialog.title.length).toBe(4096);
  });

  it("opens a select of 100 options and cancels one of 101, so a change of the schema limit shows here", () => {
    const dialogs = createDialogRegistry();
    const options = (count: number) => Array.from({ length: count }, (_, i) => `option ${i}`);
    expect(dialogs.offer(request("a", { method: "select", options: options(100) })).kind).toBe("opened");
    expect(dialogs.offer(request("b", { method: "select", options: options(101) }))).toEqual({
      kind: "cancel",
      reason: "too_large",
    });
  });
});

const approval = (id: string, fields: Record<string, unknown> = {}) => ({
  type: "approval_request" as const,
  id,
  category: "exec" as const,
  title: "Run a command?",
  message: "1 line\nbash: ls",
  answers: ["deny", "once"] as ("deny" | "once")[],
  tool: "bash",
  key: "c".repeat(64),
  tainted: false,
  ...fields,
});

describe("approvals", () => {
  it("a tainted approval and its guard rule reach the dialog", () => {
    const dialogs = createDialogRegistry();
    const result = dialogs.offerApproval({ ...approval("a1"), tainted: true, guard: "tool-calls" });
    expect(result.kind === "opened" && result.dialog).toMatchObject({ tainted: true, guard: "tool-calls" });
    const plain = createDialogRegistry().offerApproval({ ...approval("a2"), tainted: false });
    expect(plain.kind === "opened" && "tainted" in plain.dialog).toBe(false);
  });

  it("opens an approval as its own kind of dialog and keeps the grant beside it", () => {
    const dialogs = createDialogRegistry();
    expect(dialogs.offerApproval(approval("a1"))).toEqual({
      kind: "opened",
      dialog: {
        id: "a1",
        method: "approval",
        title: "Run a command?",
        message: "1 line\nbash: ls",
        category: "exec",
        answers: ["deny", "once"],
        tool: "bash",
      },
    });
    expect(dialogs.peek("a1")?.method).toBe("approval");
    expect(dialogs.takeEntry("a1")?.grant).toEqual({
      tool: "bash",
      key: "c".repeat(64),
      label: "1 line\nbash: ls",
    });
    expect(dialogs.peek("a1")).toBeNull();
  });

  it("never cuts an approval's message: one over the limit is cancelled", () => {
    expect(createDialogRegistry().offerApproval(approval("a1", { message: "x".repeat(65_537) }))).toEqual({
      kind: "cancel",
      reason: "too_large",
    });
  });

  it("cancels an approval that carries no answers or no category (fails closed)", () => {
    const dialogs = createDialogRegistry();
    expect(dialogs.offerApproval(approval("a1", { answers: [] }))).toEqual({
      kind: "cancel",
      reason: "malformed",
    });
    expect(dialogs.offerApproval(approval("a2", { answers: undefined }))).toEqual({
      kind: "cancel",
      reason: "malformed",
    });
    expect(dialogs.offerApproval(approval("a3", { category: undefined }))).toEqual({
      kind: "cancel",
      reason: "malformed",
    });
    expect(dialogs.offerApproval(approval("a4", { answers: ["once", "once"] }))).toEqual({
      kind: "cancel",
      reason: "malformed",
    });
    expect(dialogs.list()).toEqual([]);
  });

  it("cuts the label of the grant to 4096 characters and leaves the dialog whole", () => {
    const dialogs = createDialogRegistry();
    const message = "m".repeat(10_000);
    const verdict = dialogs.offerApproval(approval("a1", { message }));
    expect(verdict.kind === "opened" && verdict.dialog.message).toBe(message);
    expect(dialogs.takeEntry("a1")?.grant?.label).toBe("m".repeat(4096));
  });

  it("counts approvals in the same limits as other dialogs, and frees their bytes when taken", () => {
    const dialogs = createDialogRegistry();
    for (let i = 0; i < 63; i++) dialogs.offer(request(`c${i}`));
    expect(dialogs.offerApproval(approval("a1")).kind).toBe("opened");
    expect(dialogs.offerApproval(approval("a2"))).toEqual({ kind: "cancel", reason: "limit" });
    dialogs.takeEntry("a1");
    expect(dialogs.offerApproval(approval("a3")).kind).toBe("opened");
  });

  it("gives an extension's dialog no grant, and take() still hands out the dialog alone", () => {
    const dialogs = createDialogRegistry();
    dialogs.offer(request("d1"));
    expect(dialogs.takeEntry("d1")?.grant).toBeNull();
    dialogs.offerApproval(approval("a1"));
    expect(dialogs.take("a1")?.id).toBe("a1");
    expect(dialogs.take("a1")).toBeNull();
  });

  it("cuts the label on a character boundary: a pair of surrogates is never split", () => {
    const dialogs = createDialogRegistry();
    // The emoji is two UTF-16 units, the 4095th and 4096th: keeping half of it would leave a lone surrogate.
    dialogs.offerApproval(approval("a1", { message: `${"m".repeat(4095)}\u{1F600}tail` }));
    const label = dialogs.takeEntry("a1")?.grant?.label;
    expect(label).toBe("m".repeat(4095));
    expect(Buffer.from(label ?? "").toString()).toBe(label); // a lone surrogate would not survive UTF-8
    dialogs.offerApproval(approval("a2", { message: `${"m".repeat(4094)}\u{1F600}tail` }));
    expect(dialogs.takeEntry("a2")?.grant?.label).toBe(`${"m".repeat(4094)}\u{1F600}`);
  });

  it("refuses to mix the two kinds under one id, whichever came first", () => {
    const dialogs = createDialogRegistry();
    dialogs.offer(request("x1"));
    expect(dialogs.offerApproval(approval("x1"))).toEqual({ kind: "cancel", reason: "collision" });
    expect(dialogs.peek("x1")?.method).toBe("confirm");
    dialogs.offerApproval(approval("a1"));
    expect(dialogs.offer(request("a1"))).toEqual({ kind: "cancel", reason: "collision" });
    expect(dialogs.peek("a1")?.method).toBe("approval");
    expect(dialogs.offer(request("x1", { message: "again" })).kind).toBe("opened");
  });

  it("cancels an extension's request that names itself an approval", () => {
    expect(createDialogRegistry().offer(request("x1", { method: "approval" }))).toEqual({
      kind: "cancel",
      reason: "unknown_method",
    });
  });
});

// @vitest-environment happy-dom
import type { FireView } from "@pap/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { button, click, hasButton, settle, text } from "../../testing/dom.ts";
import { countsOf, current, newBed, showWithStepUp, taskOf, triggerOf } from "./board-bed.tsx";
import { fireOf } from "./editor-bed.tsx";
import { FireJournal } from "./FireJournal.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof newBed>;
beforeEach(() => {
  bed = newBed();
  useTasksStore.getState().reset();
});

const show = (refreshKey = 0, onOpenSession = vi.fn()) =>
  showWithStepUp(<FireJournal triggerId="g1" refreshKey={refreshKey} onOpenSession={onOpenSession} />);

const rows = (container: HTMLElement) => [...container.querySelectorAll("tbody tr")];

describe("FireJournal", () => {
  it("lists the lines with a verdict chip, the detail, the task state, the duration and the cost", async () => {
    bed.handlers["automation.journal"] = () => ({ entries: [fireOf()], hasMore: false });
    const page = await show();
    await settle();
    expect(bed.called("automation.journal")[0]?.params).toEqual({ triggerId: "g1" });
    const row = rows(page.container)[0] as HTMLElement;
    expect(row.querySelector('[data-slot="chip"]')?.textContent).toBe("fired");
    expect(row.querySelector('[data-slot="chip"]')?.getAttribute("data-tone")).toBe("ok");
    expect(row.textContent).toContain("HighMemory · api-7f9c");
    expect(row.textContent).toContain("tsk_41aaaaaa · Done");
    expect(row.textContent).toContain("3m40");
    expect(row.textContent).toContain("$0.21");
  });

  it("shows a collapsed line as ×12 with its time range", async () => {
    bed.handlers["automation.journal"] = () => ({
      entries: [
        fireOf({ id: 5, verdict: "precheck", count: 12, firstAt: 1_760_000_000_000, at: 1_760_014_400_000 }),
      ],
      hasMore: false,
    });
    const page = await show();
    await settle();
    const row = rows(page.container)[0] as HTMLElement;
    expect(row.querySelector('[data-slot="chip"]')?.textContent).toBe("precheck ×12");
    expect(row.textContent).toContain("→");
  });

  it("builds the 401 sentence from the stored mode and count", async () => {
    bed.handlers["automation.journal"] = () => ({
      entries: [fireOf({ verdict: "unauthorized", detail: "hmac", count: 3, taskId: null, taskState: null })],
      hasMore: false,
    });
    const page = await show();
    await settle();
    expect(text(page.container)).toContain("Invalid signature · 3 unauthenticated attempts");
  });

  it("draws an untrusted detail as text, with hidden characters written out", async () => {
    bed.handlers["automation.journal"] = () => ({
      entries: [fireOf({ detail: "<script>x</script>‮abc" })],
      hasMore: false,
    });
    const page = await show();
    await settle();
    expect(page.container.querySelector("script")).toBeNull();
    expect(text(page.container)).toContain("<script>x</script>\\u202Eabc");
  });

  it("filters fired and refused lines on the loaded page", async () => {
    bed.handlers["automation.journal"] = () => ({
      entries: [
        fireOf({ id: 3 }),
        fireOf({ id: 2, verdict: "dedup", detail: "same", taskId: null, taskState: null }),
      ],
      hasMore: false,
    });
    const page = await show();
    await settle();
    expect(rows(page.container)).toHaveLength(2);
    await click(button(page.container, "Refused"));
    expect(rows(page.container)).toHaveLength(1);
    expect(rows(page.container)[0]?.textContent).toContain("same");
    await click(button(page.container, "Fired"));
    expect(rows(page.container)).toHaveLength(1);
    expect(rows(page.container)[0]?.textContent).toContain("HighMemory");
    await click(button(page.container, "All"));
    expect(rows(page.container)).toHaveLength(2);
  });

  it("loads more with the oldest id as `before`, and hides the button when nothing is left", async () => {
    const page1: FireView[] = [fireOf({ id: 30 }), fireOf({ id: 20 })];
    bed.handlers["automation.journal"] = (params) =>
      (params as { before?: number }).before === undefined
        ? { entries: page1, hasMore: true }
        : { entries: [fireOf({ id: 10 })], hasMore: false };
    const page = await show();
    await settle();
    await click(button(page.container, "Load more"));
    await settle();
    expect(bed.called("automation.journal")[1]?.params).toEqual({ triggerId: "g1", before: 20 });
    expect(rows(page.container)).toHaveLength(3);
    expect(hasButton(page.container, "Load more")).toBe(false);
  });

  it("says when there is nothing yet, and when the load fails", async () => {
    bed.handlers["automation.journal"] = () => ({ entries: [], hasMore: false });
    const empty = await show();
    await settle();
    expect(text(empty.container)).toContain("No fires yet");
    await empty.unmount();
    bed.handlers["automation.journal"] = () => {
      throw new RpcError("not_found");
    };
    const failed = await show();
    await settle();
    expect(text(failed.container)).toContain("The journal could not be loaded.");
  });

  it("reloads the first page when told to", async () => {
    bed.handlers["automation.journal"] = () => ({ entries: [fireOf()], hasMore: false });
    const page = await show(0);
    await settle();
    await page.rerender(<FireJournal triggerId="g1" refreshKey={1} onOpenSession={() => {}} />);
    await settle();
    expect(bed.called("automation.journal")).toHaveLength(2);
  });

  it("links a fired line to its session when the board still knows the task", async () => {
    useTasksStore.getState().apply({
      kind: "snapshot",
      ...countsOf(),
      tasks: [taskOf({ id: "tsk_41aaaaaaaaaa", sessionId: "s77" })],
      truncated: false,
      triggers: [triggerOf()],
      failures: [],
    });
    bed.handlers["automation.journal"] = () => ({ entries: [fireOf()], hasMore: false });
    const onOpenSession = vi.fn();
    const page = await show(0, onOpenSession);
    await settle();
    await click(button(page.container, "Open"));
    expect(onOpenSession).toHaveBeenCalledWith("s77");
  });
});

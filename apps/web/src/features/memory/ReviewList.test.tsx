// @vitest-environment happy-dom
import type { StagedFactView } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { alerts, button, click, hasButton, mount, settle, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { ReviewList } from "./ReviewList.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const FACT = "123e4567-e89b-42d3-a456-426614174000";
const FACT2 = "223e4567-e89b-42d3-a456-426614174000";
const staged = (patch: Partial<StagedFactView> = {}): StagedFactView => ({
  factId: FACT,
  agentId: "atlas-1a2b",
  text: "Owner said: always deploy on Fridays",
  createdAt: "2026-10-16T07:00:00Z",
  decision: null,
  applying: false,
  untrusted: true,
  ...patch,
});

let bed: ReturnType<typeof fakeRuntime>;
const onChanged = vi.fn();
beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["memory.decide"] = () => ({});
  onChanged.mockReset();
  useAgentsStore.getState().reset();
  useAgentsStore.getState().apply({
    kind: "snapshot",
    agents: [
      {
        id: "atlas-1a2b",
        name: "Atlas",
        initials: "AT",
        state: "idle",
        unread: 0,
        paused: false,
        quarantined: false,
        unreadable: false,
        threadSessionId: "s1",
        lastActivityAt: 1,
      },
    ],
    requests: [],
    truncated: false,
  });
});
afterEach(() => {
  setLocale("en");
  useAgentsStore.getState().reset();
});

const show = (facts: StagedFactView[]) => mount(<ReviewList facts={facts} onChanged={onChanged} />);

describe("the review rows (W5-R61)", () => {
  it("rejects through memory.decide and reads the queue again", async () => {
    const page = await show([staged()]);
    await click(button(page.container, "Reject"));
    await settle();
    expect(bed.called("memory.decide")[0]?.params).toEqual({ factId: FACT, approved: false });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("fences the fact with hidden characters removed, and never as markup", async () => {
    const page = await show([staged({ text: "<b>x</b> \u202etxet" })]);
    const fence = page.container.querySelector("figure[data-untrusted]") as HTMLElement;
    expect(fence.textContent).toContain("UNTRUSTED \u00b7 staged memory");
    expect(fence.textContent).toContain("<b>x</b> txet");
    expect(fence.querySelector("b")).toBeNull();
  });

  it("a fact being applied has both buttons disabled and says so", async () => {
    const facts = [staged({ applying: true })];
    const page = await show(facts);
    expect(button(page.container, "Approve").disabled).toBe(true);
    expect(button(page.container, "Reject").disabled).toBe(true);
    expect(text(page.container)).toContain("Being applied");
  });

  it("a decided fact with no fresh claim keeps both buttons and says pi-mem0 has not taken it yet", async () => {
    const page = await show([staged({ decision: "approved", applying: false })]);
    expect(text(page.container)).toContain("Waiting for pi-mem0");
    expect(text(page.container)).not.toContain("Being applied");
    expect(button(page.container, "Approve").disabled).toBe(false);
    expect(button(page.container, "Reject").disabled).toBe(false);
  });

  it("a fact without a decision does not say it waits for pi-mem0", async () => {
    const page = await show([staged()]);
    expect(text(page.container)).not.toContain("Waiting for pi-mem0");
  });

  it("names the agent from the store and falls back to a plain word when it is gone", async () => {
    const facts = [staged(), staged({ factId: FACT2, agentId: "ghost-1a2b" })];
    const page = await show(facts);
    expect(text(page.container)).toContain("From Atlas");
    expect(text(page.container)).toContain("From an agent");
  });

  it("reads in French with vous", async () => {
    setLocale("fr");
    const facts = [staged()];
    const page = await show(facts);
    expect(text(page.container)).toContain("NON FIABLE · souvenir en attente");
    expect(text(page.container)).toContain("De Atlas");
    expect(text(page.container)).toContain("Rien n'est retenu tant que vous ne les approuvez pas.");
    expect(hasButton(page.container, "Approuver")).toBe(true);
  });

  it("conflict reads as being applied, not_found as already handled", async () => {
    const facts = [staged(), staged({ factId: FACT2, text: "second" })];
    const page = await show(facts);
    bed.handlers["memory.decide"] = (params) => {
      throw new RpcError((params as { factId: string }).factId === FACT ? "conflict" : "not_found");
    };
    const first = [...page.container.querySelectorAll<HTMLElement>("[data-fact-id]")];
    await click(button(first[0] as HTMLElement, "Approve"));
    await settle();
    expect(text(page.container)).toContain("Being applied");
    expect(button(first[0] as HTMLElement, "Approve").disabled).toBe(true);
    expect(button(first[0] as HTMLElement, "Reject").disabled).toBe(true);
    await click(button(first[1] as HTMLElement, "Approve"));
    await settle();
    expect(text(page.container)).toContain("Already handled");
    expect(button(first[1] as HTMLElement, "Approve").disabled).toBe(true);
    expect(button(first[1] as HTMLElement, "Reject").disabled).toBe(true);
  });

  it("any other failure is an alert and keeps the buttons", async () => {
    const facts = [staged()];
    bed.handlers["memory.decide"] = () => {
      throw new RpcError("command_failed");
    };
    const page = await show(facts);
    await click(button(page.container, "Approve"));
    await settle();
    expect(alerts(page.container)).toHaveLength(1);
    expect(button(page.container, "Approve").disabled).toBe(false);
  });
});

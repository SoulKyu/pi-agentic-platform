import type { ApprovalRequestRecord, SessionStreamEvent } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import { createLiveUi } from "./live-ui.ts";

const record = (id: string, fields: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord => ({
  type: "approval_request",
  id,
  category: "exec",
  title: "Run?",
  message: "bash: ls",
  answers: ["deny", "once"],
  tool: "bash",
  key: "c".repeat(64),
  tainted: false,
  toolCallId: "call-1",
  ...fields,
});

function setup() {
  const clock = createFakeClock(1_000_000);
  const shown: Array<{ toolCallId: string; answers: readonly string[]; at: number }> = [];
  const published: SessionStreamEvent[] = [];
  const handle = { send: () => true } as unknown as WorkerHandle;
  const ui = createLiveUi({
    handle,
    clock,
    logger: silentLogger,
    limiter: createRateLimiter(clock, 10_000),
    publish: (event) => void published.push(event),
    onCardShown: (toolCallId, answers, at) => void shown.push({ toolCallId, answers, at }),
  });
  return { ui, clock, shown, published };
}

describe("the card timing the live session reports (decision 117, A4)", () => {
  it("reports the call, the offered answers and the clock's time when a card is sent to the UI", async () => {
    const { ui, clock, shown } = setup();
    await clock.advance(250);
    ui.onApprovalRequest(record("a1"));
    expect(shown).toEqual([{ toolCallId: "call-1", answers: ["deny", "once"], at: 1_000_250 }]);
  });

  it("reports nothing for a card that was never shown or that names no call", () => {
    const { ui, shown } = setup();
    ui.onApprovalRequest(record("a2", { toolCallId: undefined }));
    ui.onApprovalRequest(record("a3", { answers: [] as never }));
    expect(shown).toEqual([]);
  });
});

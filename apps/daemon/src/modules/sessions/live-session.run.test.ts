import { describe, expect, it } from "vitest";
import { startLiveSession } from "./live-session.ts";
import { createLiveBed, piEvent } from "./testing/live-bed.ts";

const setup = createLiveBed(startLiveSession);

describe("abort while a prompt is in flight", () => {
  it("aborts at agent_start when Stop came while the prompt was still in flight (R113)", async () => {
    const { live, worker, clock } = setup({ holdPrompt: true });
    const prompted = live.prompt("go");
    await clock.advance(0);
    const promptId = worker.requests.find((r) => r.type === "prompt")?.id ?? "";
    await live.abort();
    expect(worker.requests.filter((r) => r.type === "abort")).toHaveLength(1);
    worker.respond(promptId, { data: { disposition: "started" } });
    await prompted;
    worker.emit(piEvent({ type: "agent_start" }));
    await clock.advance(0);
    expect(worker.requests.filter((r) => r.type === "abort")).toHaveLength(2);
  });

  it("forgets that abort when the prompt started nothing", async () => {
    const { live, worker, clock } = setup({ holdPrompt: true });
    const prompted = live.prompt("/handled-command");
    await clock.advance(0);
    const promptId = worker.requests.find((r) => r.type === "prompt")?.id ?? "";
    await live.abort();
    worker.respond(promptId, { data: { disposition: "handled" } });
    await prompted;
    worker.emit(piEvent({ type: "agent_start" }));
    await clock.advance(0);
    expect(worker.requests.filter((r) => r.type === "abort")).toHaveLength(1);
  });

  it("keeps the memory while another prompt is still in flight", async () => {
    const { live, worker, clock } = setup({ holdPrompt: true });
    const first = live.prompt("one");
    const second = live.prompt("two");
    await clock.advance(0);
    const [firstId, secondId] = worker.requests.filter((r) => r.type === "prompt").map((r) => r.id);
    await live.abort();
    worker.respond(firstId ?? "", { data: { disposition: "handled" } });
    await first;
    worker.respond(secondId ?? "", { data: { disposition: "started" } });
    await second;
    worker.emit(piEvent({ type: "agent_start" }));
    await clock.advance(0);
    expect(worker.requests.filter((r) => r.type === "abort")).toHaveLength(2);
  });
});

describe("run origin", () => {
  it("records who started a run", async () => {
    const { live, worker, recorded, clock } = setup();
    worker.emit(piEvent({ type: "agent_start" }));
    worker.emit(piEvent({ type: "agent_settled", aborted: false }));
    await clock.advance(0);
    await live.prompt("hi");
    worker.emit(piEvent({ type: "agent_start" }));
    expect(recorded.filter(([kind]) => kind === "run_start").map(([, data]) => data)).toEqual([
      { origin: "extension" },
      { origin: "user" },
    ]);
  });
});

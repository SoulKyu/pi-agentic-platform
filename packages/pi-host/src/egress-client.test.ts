import type { EgressReport } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createEgressClient } from "./egress-client.ts";
import type { Outbound } from "./ipc.ts";
import type { ShellTimers } from "./sandbox-ops.ts";

const SOCKET = "/run/user/1000/pap/ab12cd/egress/0/1.s";
const report = (id: string, over: Partial<EgressReport> = {}): EgressReport => ({
  type: "egress_report",
  id,
  hosts: [],
  truncated: false,
  up: 0,
  down: 0,
  ...over,
});

function bed(sendResult = true) {
  const sent: Outbound[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const seam: ShellTimers = {
    setTimeout: (fn, ms) => {
      const entry = { fn, ms, cleared: false };
      timers.push(entry);
      return entry;
    },
    clearTimeout: (handle) => void ((handle as { cleared: boolean }).cleared = true),
  };
  const client = createEgressClient((record) => (sent.push(record), sendResult), seam);
  const fire = (index = 0) => timers.filter((timer) => !timer.cleared)[index]?.fn();
  return { client, sent, timers, fire };
}

describe("the egress client (M11R232, worker half)", () => {
  it("asks for a socket with a counter id and returns what the daemon answers", async () => {
    const { client, sent } = bed();
    const opening = client.open();
    expect(sent).toEqual([{ type: "egress_open", id: "c1" }]);
    client.opened({ type: "egress_opened", id: "c1", socket: SOCKET, reason: null });
    await expect(opening).resolves.toEqual({ id: "c1", socket: SOCKET });
    const second = client.open();
    expect(sent.at(-1)).toEqual({ type: "egress_open", id: "c2" });
    client.opened({ type: "egress_opened", id: "c2", socket: null, reason: "limit" });
    await expect(second).resolves.toBeNull();
  });

  it("waits at most 2 s for the answer, then gives no socket and releases the id", async () => {
    const { client, sent, timers, fire } = bed();
    const opening = client.open();
    expect(timers.map((timer) => timer.ms)).toEqual([2000]);
    fire();
    await expect(opening).resolves.toBeNull();
    // The daemon may have opened it just now: a close lets it free the listener.
    expect(sent).toEqual([
      { type: "egress_open", id: "c1" },
      { type: "egress_close", id: "c1" },
    ]);
    client.opened({ type: "egress_opened", id: "c1", socket: SOCKET, reason: null });
    client.report(report("c1"));
  });

  it("gives no socket when the channel is closed", async () => {
    const { client } = bed(false);
    await expect(client.open()).resolves.toBeNull();
  });

  it("closes a command and returns its report, waiting at most 2 s", async () => {
    const { client, sent, timers, fire } = bed();
    const opening = client.open();
    client.opened({ type: "egress_opened", id: "c1", socket: SOCKET, reason: null });
    await opening;
    const closing = client.close("c1");
    expect(sent.at(-1)).toEqual({ type: "egress_close", id: "c1" });
    const answer = report("c1", { up: 5 });
    client.report(answer);
    await expect(closing).resolves.toEqual(answer);
    expect(timers.every((timer) => timer.cleared)).toBe(true);

    const second = client.open();
    client.opened({ type: "egress_opened", id: "c2", socket: SOCKET, reason: null });
    await second;
    const late = client.close("c2");
    fire();
    await expect(late).resolves.toBeNull();
  });

  it("drops a report or an answer for an id it does not wait for", async () => {
    const { client, sent } = bed();
    client.report(report("c9"));
    client.opened({ type: "egress_opened", id: "c9", socket: SOCKET, reason: null });
    const opening = client.open();
    client.report(report("c1"));
    client.opened({ type: "egress_opened", id: "c1", socket: SOCKET, reason: null });
    await expect(opening).resolves.toEqual({ id: "c1", socket: SOCKET });
    expect(sent).toHaveLength(1);
  });

  it("allows at most 8 commands in flight and frees a place on close", async () => {
    const { client, sent } = bed();
    for (let n = 1; n <= 8; n++) {
      const opening = client.open();
      client.opened({ type: "egress_opened", id: `c${n}`, socket: SOCKET, reason: null });
      await opening;
    }
    expect(await client.open()).toBeNull();
    expect(sent.filter((record) => record.type === "egress_open")).toHaveLength(8);
    const closing = client.close("c3");
    client.report(report("c3"));
    await closing;
    const again = client.open();
    client.opened({ type: "egress_opened", id: "c9", socket: SOCKET, reason: null });
    await expect(again).resolves.toEqual({ id: "c9", socket: SOCKET });
  });

  it("keeps a report for its tool call and hands it over once", () => {
    const { client } = bed();
    const mine = report("c1", { up: 1 });
    client.keep("call-1", mine);
    client.keep("call-2", null);
    expect(client.take("call-1")).toEqual(mine);
    expect(client.take("call-1")).toBeUndefined();
    expect(client.take("call-2")).toBeNull();
    expect(client.take("call-3")).toBeUndefined();
  });

  it("keeps null (taints) for an id whose earlier report was not taken yet, instead of overwriting it", () => {
    const { client } = bed();
    client.keep("call-1", report("c1", { up: 1 }));
    client.keep("call-1", report("c2", { up: 2 }));
    expect(client.take("call-1")).toBeNull();
    client.keep("call-1", report("c3"));
    expect(client.take("call-1")).toEqual(report("c3"));
  });

  it("bounds the reports it keeps, dropping the oldest", () => {
    const { client } = bed();
    for (let n = 0; n < 300; n++) client.keep(`call-${n}`, report("c1"));
    expect(client.take("call-0")).toBeUndefined();
    expect(client.take("call-299")).toEqual(report("c1"));
  });
});

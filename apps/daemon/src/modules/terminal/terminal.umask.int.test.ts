import { statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { attach, createTerminal, startWire, untilText, type Wire } from "./testing/wire.ts";

// This file starts one daemon, and `prepareHome` remembers the first umask it sees: the process starts under 027.
let before: number;
let wire: Wire | undefined;
beforeAll(() => {
  before = process.umask(0o027);
});
afterAll(async () => {
  wire?.client.close();
  await wire?.t.stop();
  process.umask(before);
});

it("starts the shell under the daemon's starting umask, not under its own 077, through the wiring", async () => {
  wire = await startWire();
  expect(process.umask()).toBe(0o077);
  const cwd = wire.t.cwd;
  const terminalId = await createTerminal(wire.client, cwd);
  const stream = await attach(wire.client, terminalId);
  stream.type("umask; echo mark-$((1+1)); : > made\r");
  await untilText(stream, "mark-2");
  expect(stream.text()).toContain("0027\r\n");
  // A file the shell creates carries the mask: 0666 without 027 is 0640.
  await vi.waitFor(() => expect(statSync(join(cwd, "made")).mode & 0o777).toBe(0o640), {
    timeout: 10_000,
    interval: 20,
  });
  expect(process.umask()).toBe(0o077);
});

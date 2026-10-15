import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./run-cli.ts";
import { cliIo } from "./testing/cli-io.ts";
import { summarizeTrace } from "./trace-summary.ts";

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const NAMES = ["rpc.sessions.list", "run", "hook"] as const;

/** 1 000 lines over three names: line i is the (i/3)-th of its name, lasts that many ms and starts (1000 - i) * 3 s ago. */
function fixtureLine(i: number): string {
  const durationMs = Math.floor(i / 3) + 1;
  return JSON.stringify({
    name: NAMES[i % 3],
    start: NOW - (1000 - i) * 3000,
    durationMs,
    outcome: durationMs % 50 === 0 ? "capacity" : "ok",
    attrs: {},
  });
}
const lines = (from: number, to: number): string[] =>
  Array.from({ length: to - from }, (_, k) => fixtureLine(from + k));

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-trace-summary-"));
  mkdirSync(join(home, "logs"));
  const log = (suffix: string, rows: string[]) =>
    writeFileSync(join(home, "logs", `trace.jsonl${suffix}`), `${rows.join("\n")}\n`);
  log(".2", lines(0, 300));
  log(".1", lines(300, 700));
  log("", [...lines(700, 1000), '{"name":"run","start":17']); // the last line is torn
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("summarizeTrace", () => {
  const all = () =>
    [0, 300, 700].map((from, k) => lines(from, [300, 700, 1000][k] ?? 1000).join("\n")).concat('{"torn');

  it("counts, ranks and finds the failures of each name, exactly", () => {
    const { rows, skipped } = summarizeTrace(all(), { now: NOW });
    expect(skipped).toBe(1);
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    // 334 values 1..334 for the first name: nearest-rank p50 = 167, p90 = 301, p99 = 331.
    expect(byName["rpc.sessions.list"]).toMatchObject({
      count: 334,
      p50: 167,
      p90: 301,
      p99: 331,
      max: 334,
      failures: 6,
    });
    expect(byName.run).toMatchObject({ count: 333, p50: 167, p90: 300, p99: 330, max: 333, failures: 6 });
    expect(byName.hook).toMatchObject({ count: 333, p50: 167, p90: 300, p99: 330, max: 333, failures: 6 });
    expect(rows.map((row) => row.name)).toEqual(["hook", "rpc.sessions.list", "run"]);
  });

  it("computes the rate per minute over the span of the lines when there is no --since", () => {
    const { rows } = summarizeTrace(all(), { now: NOW });
    const first = rows.find((row) => row.name === "rpc.sessions.list");
    // 334 lines over 999 * 3 s = 49.95 min.
    expect(first?.ratePerMinute).toBeCloseTo(334 / 49.95, 5);
  });

  it("keeps only the spans started within --since, and divides by that window", () => {
    const { rows, skipped } = summarizeTrace(all(), { now: NOW, sinceMs: 15 * 60_000 });
    expect(skipped).toBe(1);
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    // Lines 700..999 only: 100 of each name; the first name holds 235..334.
    expect(byName["rpc.sessions.list"]).toMatchObject({
      count: 100,
      p50: 284,
      p90: 324,
      p99: 333,
      max: 334,
      failures: 2,
    });
    expect(byName["rpc.sessions.list"]?.ratePerMinute).toBeCloseTo(100 / 15, 5);
    expect(byName.run).toMatchObject({ count: 100, p50: 283, p90: 323, p99: 332, max: 333 });
  });

  it("skips lines that parse but are not spans", () => {
    const { rows, skipped } = summarizeTrace(
      [
        [
          '{"name":"run","start":1,"durationMs":-3,"outcome":"ok","attrs":{}}',
          '{"name":"run","start":"x","durationMs":3,"outcome":"ok","attrs":{}}',
          '{"name":"run","start":1,"durationMs":3}',
          "[1,2]",
          "",
        ].join("\n"),
      ],
      { now: NOW },
    );
    expect(rows).toEqual([]);
    expect(skipped).toBe(4);
  });
});

describe("pap trace summary", () => {
  it("reads the current file and the nine rotated ones, and prints a table", async () => {
    const { io, stdout, stderr } = cliIo({ env: { PAP_HOME: home }, now: NOW });
    expect(await runCli(["trace", "summary"], io)).toBe(0);
    expect(stderr()).toBe("");
    const out = stdout();
    expect(out.split("\n")[0]).toMatch(/^name\s+count\s+rate\/min\s+p50\s+p90\s+p99\s+max\s+failures$/);
    expect(out).toMatch(/^rpc\.sessions\.list\s+334\s+6\.7\s+167\s+301\s+331\s+334\s+6$/m);
    expect(out).toContain("skipped lines: 1");
  });

  it("replaces control and invisible characters of a span name before printing", async () => {
    const forged = JSON.stringify({
      name: "evil\u001b[2Jx\u202ey\u009b",
      start: NOW,
      durationMs: 1,
      outcome: "ok",
    });
    writeFileSync(join(home, "logs", "trace.jsonl"), `${forged}\n`);
    const { io, stdout } = cliIo({ env: { PAP_HOME: home }, now: NOW });
    expect(await runCli(["trace", "summary"], io)).toBe(0);
    expect(stdout()).toContain("evil?[2Jx?y?");
    expect(/[\p{Cc}\p{Cf}]/u.test(stdout().replaceAll("\n", ""))).toBe(false);
  });

  it("cuts to --since 15m", async () => {
    const { io, stdout } = cliIo({ env: { PAP_HOME: home }, now: NOW });
    expect(await runCli(["trace", "summary", "--since", "15m"], io)).toBe(0);
    expect(stdout()).toMatch(/^rpc\.sessions\.list\s+100\s+6\.7\s+284\s+324\s+333\s+334\s+2$/m);
  });

  it.each(["2h", "1d", "30m"])("accepts --since %s", async (since) => {
    const { io } = cliIo({ env: { PAP_HOME: home }, now: NOW });
    expect(await runCli(["trace", "summary", "--since", since], io)).toBe(0);
  });

  it.each([["nope"], ["15"], ["0m"], ["-5m"], ["15s"], ["1.5h"], [""], ["99999d"]])(
    "answers --since %j with exit 64 and the usage",
    async (since) => {
      const { io, stderr, stdout } = cliIo({ env: { PAP_HOME: home }, now: NOW });
      expect(await runCli(["trace", "summary", "--since", since], io)).toBe(64);
      expect(stderr()).toContain("pap trace summary [--since <15m|2h|1d>]");
      expect(stdout()).toBe("");
    },
  );

  it("answers an unknown flag and a positional with exit 64", async () => {
    for (const argv of [["--bogus"], ["extra"]]) {
      const { io } = cliIo({ env: { PAP_HOME: home }, now: NOW });
      expect(await runCli(["trace", "summary", ...argv], io)).toBe(64);
    }
  });

  it("says there is no trace yet when no file exists, and creates nothing", async () => {
    const empty = join(home, "empty");
    const { io, stdout } = cliIo({ env: { PAP_HOME: empty }, now: NOW });
    expect(await runCli(["trace", "summary"], io)).toBe(0);
    expect(stdout()).toBe("no trace yet\n");
  });

  it("prints a header and no rows when --since leaves nothing", async () => {
    const { io, stdout } = cliIo({ env: { PAP_HOME: home }, now: NOW + 10 * 86_400_000 });
    expect(await runCli(["trace", "summary", "--since", "1d"], io)).toBe(0);
    expect(stdout()).toContain("no spans in the last 1d");
  });
});

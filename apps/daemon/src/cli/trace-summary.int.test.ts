import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireInstanceLock } from "../kernel/home.ts";

const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));
const pap = (args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(
    process.execPath,
    ["--conditions=development", "--disable-warning=ExperimentalWarning", MAIN, ...args],
    { env, encoding: "utf8", timeout: 30_000 },
  );

let scratch: string;
let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-cli-trace-"));
  home = join(scratch, "home");
  env = { PATH: process.env.PATH, PAP_HOME: home, HOME: join(scratch, "user") };
  mkdirSync(join(home, "logs"), { recursive: true });
  const span = (name: string, durationMs: number, outcome: string) =>
    JSON.stringify({ name, start: Date.now() - 1000, durationMs, outcome, attrs: {} });
  writeFileSync(
    join(home, "logs", "trace.jsonl"),
    [span("hook", 10, "ok"), span("hook", 30, "ok"), span("run", 500, "capacity")].join("\n") + "\n",
  );
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("pap trace summary (the real entry point)", () => {
  it("prints the table and exits 0", () => {
    const run = pap(["trace", "summary"], env);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^name\s+count\s+rate\/min\s+p50\s+p90\s+p99\s+max\s+failures$/m);
    expect(run.stdout).toMatch(/^hook\s+2\s+\S+\s+10\s+30\s+30\s+30\s+0$/m);
    expect(run.stdout).toMatch(/^run\s+1\s+\S+\s+500\s+500\s+500\s+500\s+1$/m);
  });

  it("works beside a live daemon: it takes no instance lock", () => {
    const lock = acquireInstanceLock(home);
    try {
      const run = pap(["trace", "summary", "--since", "1h"], env);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("hook");
    } finally {
      lock.release();
    }
  });

  it("exits 64 with the usage on a bad --since", () => {
    const run = pap(["trace", "summary", "--since", "nope"], env);
    expect(run.status).toBe(64);
    expect(run.stderr).toContain("pap trace summary [--since <15m|2h|1d>]");
    expect(run.stdout).toBe("");
  });

  it("says there is no trace yet on a home that has none, and exits 0", () => {
    const run = pap(["trace", "summary"], { ...env, PAP_HOME: join(scratch, "empty") });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("no trace yet\n");
  });
});

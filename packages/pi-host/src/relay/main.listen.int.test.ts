import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

/*
 * S1 item 11 (AVM-E49 M9a): a relay that cannot bind its address exits 70, reports no `relay_ready`, and says why on stderr, which
 * the daemon logs. Mutant: the error class dropped from the message (`could not listen` alone) -> this case fails.
 */
const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("exits 70 naming the bind error class when the port is held by another process", async () => {
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const { port } = holder.address() as { port: number };
  const dir = mkdtempSync(join(tmpdir(), "relay-listen-"));
  dirs.push(dir);
  try {
    const child = fork(MAIN, ["--listen", `127.0.0.1:${port}`], {
      env: { PATH: process.env.PATH, HOME: dir, LANG: "C.UTF-8", PI_CODING_AGENT_DIR: dir },
      execArgv: ["--conditions=development", "--disable-warning=ExperimentalWarning"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const records: unknown[] = [];
    const stderr: string[] = [];
    child.on("message", (record) => records.push(record));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    child.stdout?.resume();
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(70);
    expect(records).toEqual([]);
    expect(stderr.join("")).toContain("could not listen (EADDRINUSE)");
  } finally {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
});

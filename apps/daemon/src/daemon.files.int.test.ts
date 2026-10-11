import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";

// The umask a shell gives the daemon. It is what the workers must run their tools under, not the daemon's own 077.
process.umask(0o022);

const mode = (path: string) => statSync(path).mode & 0o777;
const DATABASE_FILES = ["state.db", "state.db-wal", "state.db-shm"];
const WRITE = {
  steps: [
    { toolCalls: [{ name: "write", args: { path: "made/note.txt", content: "hello" }, id: "call-1" }] },
    { text: "done" },
  ],
};

let t: TestDaemon | undefined;
const extra: string[] = [];
afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const dir of extra.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the files the daemon makes and the files its workers make", () => {
  it("keeps the home 0700 and state.db with its WAL and shared memory file 0600 (R68, R117)", async () => {
    t = await startTestDaemon({ steps: [{ text: "hi" }] });
    expect(process.umask()).toBe(0o077);
    const home = t.home;
    for (const dir of [home, ...["backups", "secrets", "logs"].map((name) => join(home, name))]) {
      expect(mode(dir), dir).toBe(0o700);
    }
    for (const name of DATABASE_FILES) expect(mode(join(t.home, name)), name).toBe(0o600);
  });

  it("tightens a home that an earlier run left open (R117)", async () => {
    const home = join(tmpdir(), `pap-files-${process.pid}`);
    extra.push(home);
    mkdirSync(join(home, "backups"), { recursive: true });
    chmodSync(home, 0o755);
    chmodSync(join(home, "backups"), 0o755);
    writeFileSync(join(home, "state.db"), "");
    chmodSync(join(home, "state.db"), 0o644);
    t = await startTestDaemon({ steps: [{ text: "hi" }] }, { config: { home } });
    for (const dir of [home, join(home, "backups")]) expect(mode(dir), dir).toBe(0o700);
    for (const name of DATABASE_FILES) expect(mode(join(home, name)), name).toBe(0o600);
  });

  it("runs the workers' tools under the umask the daemon was started with, not its own 077 (R114)", async () => {
    t = await startTestDaemon(WRITE);
    const client = await t.connect(await t.login());
    const created = await client.call("sessions.create", { cwd: t.cwd });
    const sessionId = (created as { result: { sessionId: string } }).result.sessionId;
    await client.call("subscribe.session", { sessionId });
    await client.call("sessions.prompt", { sessionId, text: "Write the note" });
    const end = await client.waitForEvent(
      (f) => (f.event as { event?: { type?: string } }).event?.type === "tool_execution_end",
    );
    expect(JSON.stringify(end.event)).not.toContain('"isError":true');
    expect(mode(join(t.cwd, "made", "note.txt"))).toBe(0o644);
    expect(mode(join(t.cwd, "made"))).toBe(0o755);
    client.close();
  });
});

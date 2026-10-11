import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InitRecord, SessionStreamEvent } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { workerEnv } from "../../kernel/supervisor/env.ts";
import { spawnWorker, type WorkerHandle } from "../../kernel/supervisor/worker.ts";
import { type LiveSession, startLiveSession } from "./live-session.ts";
import { loadTranscriptReader } from "./transcript.ts";

// A live session over a real pi-host worker on a scripted model: the daemon's leaf and its `entry` and `row` events
// must follow the worker's prompts, a navigation and a compaction, none of which Pi announces itself (Pi 1.1.0).
const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const WAIT = { timeout: 20_000 };

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function start() {
  const root = mkdtempSync(join(tmpdir(), "pap-live-leaf-"));
  const [agentDir, work, papHome, home] = ["agent", "work", "pap", "home"].map((name) =>
    join(root, name),
  ) as [string, string, string, string];
  for (const dir of [agentDir, work, papHome, home]) mkdirSync(dir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
  const script = join(root, "script.json");
  const texts = ["one", "two", "three", "a summary of the session", "a summary of the turn prefix"];
  writeFileSync(script, JSON.stringify({ steps: texts.map((text) => ({ text })) }));
  const handle: WorkerHandle = spawnWorker({
    entry: join(REPO, "packages/pi-host/src/main.ts"),
    execArgv: [
      "--conditions=development",
      "--disable-warning=ExperimentalWarning",
      "--import",
      join(REPO, "packages/pi-host/src/testing/network-guard.ts"),
    ],
    cwd: work,
    env: workerEnv(
      { PATH: process.env.PATH, LANG: process.env.LANG, HOME: home },
      { PI_CODING_AGENT_DIR: agentDir, PAP_TEST_PROVIDER: "1", PI_OFFLINE: "1" },
    ),
    clock: createSystemClock(),
    logger: silentLogger,
  });
  const published: SessionStreamEvent[] = [];
  const init: InitRecord = {
    type: "init",
    cwd: work,
    agentDir,
    papHome,
    umask: 0o022,
    policy: { profile: "interactive", approvalMode: "auto-accept-edits", alwaysAllow: [] },
    testProviderScript: script,
  };
  const live: LiveSession = startLiveSession(
    {
      handle,
      clock: createSystemClock(),
      logger: silentLogger,
      publish: (event) => void published.push(event),
      record: () => {},
      onActivity: () => {},
      onExit: () => {},
      onName: () => {},
      idleMs: 0,
    },
    init,
  );
  cleanup = async () => {
    await handle.stop();
    const blocked = handle
      .outputTail()
      .split("\n")
      .filter((line) => line.startsWith("pap-network-guard: blocked"));
    rmSync(root, { recursive: true, force: true });
    if (blocked.length > 0) throw new Error(`a worker tried to reach the network:\n${blocked.join("\n")}`);
  };
  const ready = await live.ready;
  const entries = () =>
    published.flatMap((event) =>
      event.kind === "entry" && event.entry.type === "message" ? [event.entry] : [],
    );
  async function prompt(text: string): Promise<void> {
    const before = published.length;
    await live.prompt(text);
    await vi.waitFor(() => {
      const statuses = published
        .slice(before)
        .flatMap((event) => (event.kind === "status" ? [event.status] : []));
      if (statuses.lastIndexOf("idle") <= statuses.indexOf("running")) throw new Error("still running");
    }, WAIT);
  }
  const fileIds = () =>
    readFileSync(ready.sessionFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: string; type: string })
      .filter((entry) => entry.type !== "session")
      .map((entry) => entry.id);
  return { live, handle, ready, published, entries, prompt, fileIds };
}

describe("the daemon's view of Pi's leaf with a real worker", () => {
  it("starts from a leaf in ready on a fresh session, and follows two prompts", async () => {
    const { live, ready, entries, prompt, fileIds } = await start();
    expect(ready.leafId).toEqual(expect.any(String));
    expect(live.leafId()).toBe(ready.leafId);
    await prompt("first");
    await prompt("second");
    // Pi's system prompt entry is not announced to the client (R107); the leaf still moves past it.
    expect(entries().map((entry) => entry.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(live.leafId()).toBe(entries().at(-1)?.id);
    expect(entries().map((entry) => entry.id)).toEqual(fileIds().slice(-4));
  });

  it("follows a navigation, the branch that grows from it, and a compaction", async () => {
    const { live, handle, ready, published, entries, prompt, fileIds } = await start();
    await prompt("first");
    await prompt("second");
    const firstReply = entries().filter((entry) => entry.role === "assistant")[0]?.id ?? "";
    const navigated = await handle.request({ type: "navigate_tree", targetId: firstReply });
    expect(navigated).toMatchObject({ success: true, data: { leafId: firstReply } });
    await vi.waitFor(() => expect(live.leafId()).toBe(firstReply), WAIT);

    await prompt("third");
    const third = entries()
      .filter((entry) => entry.role === "user")
      .at(-1);
    expect(third?.parentId).toBe(firstReply);
    expect(live.leafId()).toBe(entries().at(-1)?.id);
    expect(entries().at(-1)?.parentId).toBe(third?.id);

    expect(await handle.request({ type: "compact" })).toMatchObject({ success: true });
    const row = await vi.waitFor(() => {
      const found = published.find((event) => event.kind === "row");
      if (!found || found.kind !== "row") throw new Error("no row yet");
      return found.row;
    }, WAIT);
    expect(row.entryId).toBe(fileIds().at(-1));
    expect(live.leafId()).toBe(row.entryId);
    // Seen live and read from the file, the row is the same.
    const reader = await loadTranscriptReader();
    const fromFile = reader
      .page(ready.sessionFile)
      .rows.find((candidate) => candidate.entryId === row.entryId);
    expect(fromFile).toEqual(row);
    expect(row.message).toMatchObject({
      role: "compactionSummary",
      summary: expect.stringContaining("a summary of the session"),
    });
  });
});

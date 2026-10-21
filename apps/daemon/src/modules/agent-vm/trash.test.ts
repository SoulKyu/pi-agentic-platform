import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createFakeVmd, type FakeVmd } from "./testing/fake-vmd.ts";
import { disposeAgent, purgeAgent, startTrashSweep, TRASH_KEEP_MS } from "./trash.ts";

/*
 * Mutants (RT-43), run for real in the T15a report: "purge the disk" (the dispose case sends purge:true), "mirrors moved before
 * the disk call" (the conflict case), "prefix match" (the other-agent case), "sweep age dropped" (the young entry goes),
 * "sweep follows links" (the link case), "purge removes the home trash" (the purge case), "timer not re-armed" (the daily case).
 */
const DAY = 86_400_000;
let root: string;
let clock: FakeClock;
let fake: FakeVmd;

const trash = () => join(root, "agents", ".trash");
const mirrors = (id: string) => join(root, "agents", ".mirrors", id);
const deps = () => ({ client: fake, papHome: root, clock, logger: silentLogger });
const put = (path: string, text = "x") => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-t15-trash-"));
  clock = createFakeClock(Date.UTC(2026, 9, 20));
  fake = createFakeVmd();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("disposeAgent (delete)", () => {
  it("sends the disk to pap-vmd's trash and the mirrors to the daemon's, named by the stamp", async () => {
    fake.disks.set("scout-0001", 4096);
    put(join(mirrors("scout-0001"), "s.jsonl"), "line\n");
    await disposeAgent(deps(), "scout-0001", 1_760_000_000_000);
    expect(fake.of("disk.delete")).toEqual([
      { op: "disk.delete", agentId: "scout-0001", taskKey: null, purge: false },
    ]);
    expect(existsSync(mirrors("scout-0001"))).toBe(false);
    expect(readFileSync(join(trash(), "scout-0001-1760000000000.mirrors", "s.jsonl"), "utf8")).toBe("line\n");
    expect(statSync(trash()).mode & 0o777).toBe(0o700);
  });

  it("goes on when pap-vmd holds no disk for the agent, and when run twice", async () => {
    put(join(mirrors("scout-0001"), "s.jsonl"));
    await disposeAgent(deps(), "scout-0001", 1_760_000_000_000);
    await expect(disposeAgent(deps(), "scout-0001", 1_760_000_000_001)).resolves.toBeUndefined();
    expect(readdirSync(trash())).toEqual(["scout-0001-1760000000000.mirrors"]);
  });

  it("moves a second set of mirrors beside the first when the same stamp comes back", async () => {
    put(join(mirrors("scout-0001"), "a.jsonl"), "a");
    await disposeAgent(deps(), "scout-0001", 1_760_000_000_000);
    put(join(mirrors("scout-0001"), "b.jsonl"), "b");
    await disposeAgent(deps(), "scout-0001", 1_760_000_000_000);
    expect(readdirSync(trash()).sort()).toEqual([
      "scout-0001-1760000000000.mirrors",
      "scout-0001-1760000000000.mirrors-1",
    ]);
  });

  it("keeps the mirrors where they are when pap-vmd refuses (a VM still holds the disk)", async () => {
    put(join(mirrors("scout-0001"), "s.jsonl"));
    fake.failNext("disk.delete", "conflict");
    await expect(disposeAgent(deps(), "scout-0001", 1_760_000_000_000)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(existsSync(join(mirrors("scout-0001"), "s.jsonl"))).toBe(true);
  });

  it("moves only the mirrors when there is no pap-vmd (the process backend)", async () => {
    put(join(mirrors("scout-0001"), "s.jsonl"));
    await disposeAgent({ ...deps(), client: null }, "scout-0001", 1_760_000_000_000);
    expect(fake.requests).toEqual([]);
    expect(existsSync(mirrors("scout-0001"))).toBe(false);
  });
});

describe("purgeAgent (Purge now)", () => {
  it("asks pap-vmd to purge the agent and removes that agent's mirrors in the trash, nothing else", async () => {
    put(join(trash(), "scout-0001-1760000000000.mirrors", "s.jsonl"));
    put(join(trash(), "scout-0001-1760000000000", "MEMORY.md"));
    put(join(trash(), "scout-0001-0123-1760000000000.mirrors", "s.jsonl"));
    put(join(trash(), "other-0002-1760000000000.mirrors", "s.jsonl"));
    await purgeAgent(deps(), "scout-0001");
    expect(fake.of("trash.purge")).toEqual([{ op: "trash.purge", agentId: "scout-0001" }]);
    expect(readdirSync(trash()).sort()).toEqual([
      "other-0002-1760000000000.mirrors",
      "scout-0001-0123-1760000000000.mirrors",
      "scout-0001-1760000000000",
    ]);
  });

  it("leaves the mirrors when pap-vmd fails, so the purge can be asked again", async () => {
    put(join(trash(), "scout-0001-1760000000000.mirrors", "s.jsonl"));
    fake.failNext("trash.purge", "unavailable");
    await expect(purgeAgent(deps(), "scout-0001")).rejects.toMatchObject({ code: "sandbox_unavailable" });
    expect(existsSync(join(trash(), "scout-0001-1760000000000.mirrors"))).toBe(true);
  });

  it("works with no trash folder", async () => {
    await expect(purgeAgent(deps(), "scout-0001")).resolves.toBeUndefined();
  });
});

describe("the daily sweep of the daemon's trash (RT-40)", () => {
  const stamp = (ago: number) => clock.now() - ago;

  it("removes entries older than 7 days (home, scratch, mirrors) and keeps the rest", async () => {
    const old = stamp(TRASH_KEEP_MS + DAY);
    const young = stamp(TRASH_KEEP_MS - DAY);
    for (const name of [
      `scout-0001-${old}`,
      `scout-0001-${old}.runs`,
      `scout-0001-${old}.mirrors`,
      `scout-0001-${old}.mirrors-1`,
      `scout-0002-${young}`,
      `scout-0002-${young}.mirrors`,
      "notes.txt",
      `not an id-${old}`,
    ])
      put(join(trash(), name, "f"));
    const stop = startTrashSweep(deps());
    expect(readdirSync(trash()).sort()).toEqual([
      "not an id-" + old,
      "notes.txt",
      `scout-0002-${young}`,
      `scout-0002-${young}.mirrors`,
    ]);
    stop();
  });

  it("never follows a link: only the link goes", async () => {
    const old = stamp(TRASH_KEEP_MS + DAY);
    put(join(root, "outside", "keep.txt"), "keep");
    mkdirSync(trash(), { recursive: true });
    symlinkSync(join(root, "outside"), join(trash(), `scout-0001-${old}.mirrors`));
    const stop = startTrashSweep(deps());
    expect(readdirSync(trash())).toEqual([]);
    expect(readFileSync(join(root, "outside", "keep.txt"), "utf8")).toBe("keep");
    stop();
  });

  it("runs at start and every day after, and stops when told", async () => {
    mkdirSync(trash(), { recursive: true });
    const stop = startTrashSweep(deps());
    put(join(trash(), `scout-0001-${stamp(TRASH_KEEP_MS + 1000)}`, "f"));
    await clock.advance(DAY);
    expect(readdirSync(trash())).toEqual([]);
    put(join(trash(), `scout-0001-${stamp(TRASH_KEEP_MS + 1000)}`, "f"));
    await clock.advance(DAY);
    expect(readdirSync(trash())).toEqual([]);
    stop();
    expect(clock.pending()).toBe(0);
  });

  it("logs a folder it cannot remove and goes on", async () => {
    const old = stamp(TRASH_KEEP_MS + DAY);
    put(join(trash(), `scout-0001-${old}`, "f"));
    put(join(trash(), `scout-0002-${old}`, "f"));
    const removed: string[] = [];
    const stop = startTrashSweep({
      ...deps(),
      remove: (path) => {
        if (path.includes("scout-0001")) throw new Error("locked");
        removed.push(path);
      },
    });
    expect(removed).toHaveLength(1);
    stop();
  });
});

describe("the agent file store's trash", () => {
  it("is purged by Purge now even without a mirrors trash, and swept after the keep time with the rest", async () => {
    const purged: string[] = [];
    const swept: Array<[number, number]> = [];
    const files = {
      purgeTrash: (id: string) => void purged.push(id),
      sweepTrash: (now: number, keep: number) => void swept.push([now, keep]),
    };
    await purgeAgent({ ...deps(), files }, "scout-0001");
    expect(purged).toEqual(["scout-0001"]);
    const stop = startTrashSweep({ ...deps(), files });
    expect(swept).toEqual([[clock.now(), TRASH_KEEP_MS]]);
    stop();
  });
});

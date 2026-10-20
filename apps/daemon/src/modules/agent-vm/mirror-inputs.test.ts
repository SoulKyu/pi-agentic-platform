import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { AGENT, appendOf, type Bed, entry, FILE, HEADER, makeBed, userEntry } from "./mirror-fixtures.ts";
import { unverifiedIds } from "./mirror-facts.ts";
import { createMirrorInputs, type MirrorInputsDeps } from "./mirror-inputs.ts";
import { QUOTA_NOTICE } from "./mirror-quota.ts";
import { REPLACED_NOTICE } from "./mirror.ts";
import type { MirrorPort } from "./vm-worker.ts";

const ROW = { id: "0f6c0f2e-1111-4222-8333-444455556666", agentId: AGENT, piPath: null as string | null };

let bed: Bed;
let clock: FakeClock;
let notices: Array<[string, string]>;
let taints: string[];
let writable: boolean;
let inputs: ReturnType<typeof createMirrorInputs>;
const log = captureLogger();

function make(extra: Partial<MirrorInputsDeps> = {}) {
  bed = makeBed();
  clock = createFakeClock();
  notices = [];
  taints = [];
  writable = true;
  log.lines.length = 0;
  inputs = createMirrorInputs({
    papHome: bed.root,
    clock,
    logger: log.logger,
    minFreeDiskMb: 0,
    notice: (sessionId, text) => void notices.push([sessionId, text]),
    taint: (sessionId) => void taints.push(sessionId),
    canWrite: () => writable,
    ...extra,
  });
}
afterEach(() => {
  inputs.close();
  bed.dispose();
});

const portOf = (row = ROW, file = FILE, resources?: { diskMb: number }): MirrorPort => {
  const input = inputs.inputFor(row, resources);
  const port = input.mirrorFor(file);
  if (port === "refused") throw new Error("refused");
  return port;
};

describe("inputFor (T9b)", () => {
  it("names the mirror's file for a row that has one, null for a new session", () => {
    make();
    expect(inputs.inputFor(ROW).sessionFile).toBeNull();
    const bound = { ...ROW, piPath: join(bed.root, "agents", ".mirrors", AGENT, FILE) };
    expect(inputs.inputFor(bound).sessionFile).toBe(FILE);
  });

  it("opens the mirror under .mirrors/<agent>/ and answers its facts", () => {
    make();
    writeFileSync(join(bed.folder, "other.jsonl"), HEADER, { mode: 0o600 });
    const port = portOf();
    expect(port.path).toBe(bed.path);
    expect(port.facts()).toEqual({ size: 0, lastEntryId: null });
  });

  it("refuses what is not one session file of this agent", () => {
    make();
    const input = inputs.inputFor(ROW);
    expect(input.mirrorFor("../evil.jsonl")).toBe("refused");
    expect(input.mirrorFor("notes.txt")).toBe("refused");
    expect(inputs.inputFor({ ...ROW, agentId: "../x" }).mirrorFor(FILE)).toBe("refused");
    expect(log.lines.filter((line) => line.msg === "agent_mirror_refused").map((l) => l.reason)).toEqual([
      "file",
      "file",
      "file",
    ]);
  });

  it("a new session cannot take a file that exists: it could be another session's mirror", () => {
    make();
    writeFileSync(bed.path, HEADER, { mode: 0o600 });
    expect(inputs.inputFor(ROW).mirrorFor(FILE)).toBe("refused");
  });

  it("a reopen names its own file only", () => {
    make();
    writeFileSync(bed.path, HEADER, { mode: 0o600 });
    const bound = { ...ROW, piPath: bed.path };
    const input = inputs.inputFor(bound);
    expect(input.mirrorFor("2026-10-19T11-00-00-000Z_aaaaaaaa.jsonl")).toBe("refused");
    expect(input.mirrorFor(FILE)).not.toBe("refused");
  });

  it("keeps a session's sent texts between spawns: a prompt pap sent is verified by the next worker's mirror", () => {
    make();
    inputs.inputFor(ROW).sent("hello from pap");
    const port = portOf();
    port.onSessionAppend(appendOf(0, HEADER + userEntry("u1", "hello from pap") + userEntry("u2", "forged")));
    expect([...unverifiedIds(bed.path).ids]).toEqual(["u2"]);
  });

  it("another session's sent texts do not verify this one's entries", () => {
    make();
    inputs.inputFor({ ...ROW, id: "other" }).sent("hello");
    portOf().onSessionAppend(appendOf(0, HEADER + userEntry("u1", "hello")));
    expect([...unverifiedIds(bed.path).ids]).toEqual(["u1"]);
  });

  it("the agent's disk quota is the launch's diskMb", () => {
    make();
    const port = portOf(ROW, FILE, { diskMb: 1 });
    const big = (id: string) => entry(id, { pad: "p".repeat(900 * 1024) });
    expect(port.onSessionAppend(appendOf(0, HEADER + big("e1")))).toBe("ok");
    expect(port.onSessionAppend(appendOf(port.facts().size, big("e2")))).toBe("refused");
    expect(notices).toEqual([[ROW.id, QUOTA_NOTICE]]);
    expect(taints).toEqual([]);
  });
});

describe("what a replacement does to the session (R14, RT-42)", () => {
  const rewrite = (port: MirrorPort) => {
    port.onSessionAppend(appendOf(0, HEADER + entry("e1") + entry("e2")));
    port.onSessionAppend(appendOf(0, HEADER + entry("x1"), { replace: true }));
  };

  it("posts the notice and taints the session, once", () => {
    make();
    const port = portOf();
    rewrite(port);
    expect(notices).toEqual([[ROW.id, REPLACED_NOTICE]]);
    expect(taints).toEqual([ROW.id]);
    expect(readdirSync(join(bed.folder, "replaced")).filter((n) => !n.endsWith(".ids"))).toHaveLength(1);
  });

  it("in read-only database mode the file is still kept, nothing is posted, and the notice waits", () => {
    make();
    writable = false;
    const port = portOf();
    rewrite(port);
    expect(notices).toEqual([]);
    expect(taints).toEqual([]);
    expect(readdirSync(join(bed.folder, "replaced")).filter((n) => !n.endsWith(".ids"))).toHaveLength(1);
    writable = true;
    port.onSessionAppend(appendOf(port.facts().size, entry("x2")));
    expect(notices).toEqual([[ROW.id, REPLACED_NOTICE]]);
    expect(taints).toEqual([ROW.id]);
  });

  it("says once that deferred notices were dropped when more than 64 wait", () => {
    make();
    writable = false;
    const port = portOf();
    port.onSessionAppend(appendOf(0, HEADER + entry("e0")));
    for (let i = 1; i <= 70; i++)
      port.onSessionAppend(appendOf(0, HEADER + entry(`x${i}`), { replace: true }));
    expect(log.lines.filter((line) => line.msg === "agent_mirror_notices_dropped")).toHaveLength(1);
    expect(notices).toEqual([]);
  });

  it("an announcement still waiting is posted when the next mirror of the daemon is opened", () => {
    make();
    writable = false;
    rewrite(portOf());
    writable = true;
    inputs.inputFor(ROW);
    expect(taints).toEqual([ROW.id]);
  });
});

describe("the kept copies (R14)", () => {
  it("are swept after 7 days by the sweeper the inputs start", async () => {
    make();
    const port = portOf();
    port.onSessionAppend(appendOf(0, HEADER + entry("e1")));
    port.onSessionAppend(appendOf(0, HEADER + entry("x1"), { replace: true }));
    expect(readdirSync(join(bed.folder, "replaced")).filter((n) => !n.endsWith(".ids"))).toHaveLength(1);
    inputs.start();
    await clock.advance(7 * 24 * 3_600_000 + 3_600_000);
    expect(readdirSync(join(bed.folder, "replaced"))).toHaveLength(0);
    inputs.close();
    expect(clock.pending()).toBe(0);
    expect(existsSync(bed.path)).toBe(true);
  });
});

// J1b. Mutant: `unsent` answers false for everything -> "a forged user message is unsent" fails;
// `unsent` consumes the match -> "looking does not consume" fails (the mirror would then mark a sent entry).
describe("the live verdict on a user message (R32, J1b)", () => {
  const user = (content: unknown) => ({ role: "user", content });

  it("a forged user message is unsent, the one pap sent is not, and looking does not consume", () => {
    make();
    const input = inputs.inputFor(ROW);
    input.sent("hello");
    expect(input.unsent(user("forged"))).toBe(true);
    expect(input.unsent(user("hello"))).toBe(false);
    expect(input.unsent(user("hello"))).toBe(false);
    expect(input.unsent(user([{ type: "text", text: "hello" }]))).toBe(false);
  });

  it("is about user messages only, and a `/` prompt lets one entry through", () => {
    make();
    const input = inputs.inputFor(ROW);
    expect(input.unsent({ role: "assistant", content: "forged" })).toBe(false);
    expect(input.unsent("not a message")).toBe(false);
    input.sent("/review");
    expect(input.unsent(user("the expanded template"))).toBe(false);
  });

  it("is the same record the mirror's verdict uses: a second input of the session sees what the first was sent", () => {
    make();
    inputs.inputFor(ROW).sent("hello");
    expect(inputs.inputFor(ROW).unsent(user("hello"))).toBe(false);
  });
});

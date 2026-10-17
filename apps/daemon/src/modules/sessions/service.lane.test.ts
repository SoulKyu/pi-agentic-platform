import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createLaneHooks, type LaneHooksSlot, type LaneRunHooks, type LaneRunInfo } from "./lane-hooks.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { codeOf } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

let slot: LaneHooksSlot;
const build = (options: BedOptions = {}) =>
  createServiceBed(
    {
      createSessionsStore,
      createSessionsService: (parts) => {
        slot = createLaneHooks({
          clock: parts.clock,
          logger: silentLogger,
          infoOf: (sessionId) => {
            const row = parts.store.get(sessionId);
            return row ? { ownerId: row.ownerId, sessionId, cwd: row.cwd, leafId: null } : null;
          },
        });
        return createSessionsService({ ...parts, laneHooks: slot });
      },
      loadTranscriptReader,
    },
    options,
  );
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const hooks = (over: Partial<LaneRunHooks>): LaneRunHooks => ({
  closed: () => null,
  holdsFiles: () => null,
  beforePrompt: async () => {},
  afterRun: () => {},
  ...over,
});
const prompts = () => bed.spawned[0]?.requests.filter((request) => request.type === "prompt").length ?? 0;

describe("the lane hooks in sessions.prompt (M9R114)", () => {
  it("awaits the hook before the prompt reaches the worker", async () => {
    bed = build();
    let release!: () => void;
    const seen: LaneRunInfo[] = [];
    slot.set(
      hooks({
        beforePrompt: (info) => {
          seen.push(info);
          return new Promise<void>((resolve) => (release = resolve));
        },
      }),
    );
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const sent = bed.service.prompt({ sessionId, text: "go" }, OWNER);
    await bed.clock.advance(0);
    expect(prompts()).toBe(0);
    release();
    await sent;
    expect(prompts()).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ ownerId: OWNER.userId, sessionId, cwd: bed.work });
  });

  it("starts no prompt in a lane being archived (session_busy) or archived (not_found)", async () => {
    bed = build();
    let state: "archiving" | "archived" = "archiving";
    slot.set(hooks({ closed: () => state }));
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(await codeOf(bed.service.prompt({ sessionId, text: "go" }, OWNER))).toBe("session_busy");
    state = "archived";
    expect(await codeOf(bed.service.prompt({ sessionId, text: "go" }, OWNER))).toBe("not_found");
    expect(prompts()).toBe(0);
  });

  it("calls afterRun once when a run ends, from the published status events", async () => {
    bed = build();
    const ended: LaneRunInfo[] = [];
    slot.set(hooks({ afterRun: (info) => void ended.push(info) }));
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await bed.service.prompt({ sessionId, text: "go" }, OWNER);
    bed.emit(0, { type: "agent_start" });
    await bed.clock.advance(0);
    expect(ended).toEqual([]);
    bed.emit(0, { type: "agent_settled", aborted: false });
    await bed.clock.advance(0);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ sessionId, cwd: bed.work });
  });
});

describe("the busy rule with hooks set (M2R88)", () => {
  it("refuses a compaction that arrives while a prompt waits for its worker, with no-op hooks set", async () => {
    bed = build({
      replies: { compact: "held", prompt: "held" },
      start: (index) => (index === 0 ? undefined : { kind: "silent" }),
    });
    slot.set(hooks({ beforePrompt: () => undefined }));
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await bed.clock.advance(0);
    void bed.service.prompt({ sessionId, text: "go" }, OWNER).catch(() => undefined);
    await bed.clock.advance(0);
    const compacted = bed.service.compact({ sessionId }, OWNER).then(
      () => "sent",
      (error: PapError) => error.code,
    );
    bed.spawned[1]?.emit({
      type: "ready",
      sessionId: "pi-1",
      sessionFile: `${bed.agentDir}/sessions/--w--/pi-1.jsonl`,
      piVersion: "1.1.0",
      leafId: null,
      sessionName: null,
    });
    expect(await compacted).toBe("session_busy");
    expect(bed.spawned[1]?.requests.map((request) => request.type)).toEqual(["prompt"]);
  });
});

describe("releaseIdle and the lane probe on the service (M9R113, M9R37)", () => {
  it("releaseIdle stops the owner's idle worker and leaves a running or foreign one", async () => {
    bed = build();
    const a = (await bed.service.create(bed.work, OWNER)).sessionId;
    const b = (await bed.service.create(bed.otherWork, OWNER)).sessionId;
    expect(bed.service.releaseIdle("u2", a)).toBe("cold");
    await bed.service.prompt({ sessionId: b, text: "go" }, OWNER);
    bed.emit(1, { type: "agent_start" });
    await bed.clock.advance(0);
    expect(bed.service.releaseIdle(OWNER.userId, b)).toBe("busy");
    expect(bed.service.releaseIdle(OWNER.userId, a)).toBe("released");
    await bed.clock.advance(0);
    expect(bed.service.list(OWNER).find((s) => s.id === a)?.status).toBe("cold");
    expect(bed.service.releaseIdle(OWNER.userId, a)).toBe("cold");
  });

  it("releaseIdle refuses a session whose prompt waits in the lane hooks", async () => {
    bed = build();
    let release!: () => void;
    slot.set(hooks({ beforePrompt: () => new Promise<void>((resolve) => (release = resolve)) }));
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const sent = bed.service.prompt({ sessionId, text: "go" }, OWNER);
    await bed.clock.advance(0);
    expect(bed.service.releaseIdle(OWNER.userId, sessionId)).toBe("busy");
    release();
    await sent;
  });

  it("reads the branch path and the last agent text of a session's file; another owner gets not_found", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.writePiFile(0, [
      ["first ask", "first answer"],
      ["second ask", "the last answer"],
    ]);
    bed.emit(0, { type: "agent_settled", aborted: false });
    const path = await bed.service.laneProbe.branchPath(OWNER, sessionId);
    expect(path.entries.filter((entry) => entry.user).map((entry) => entry.preview)).toEqual([
      "first ask",
      "second ask",
    ]);
    expect(path.entries[0]?.parentId).toBeNull();
    expect(path.entries.at(-1)?.id).toBe(path.leafId);
    expect(await bed.service.laneProbe.agentText(sessionId, 100)).toBe("the last answer");
    expect(await bed.service.laneProbe.agentText(sessionId, 8)).toBe("the last");
    expect(await codeOf(bed.service.laneProbe.branchPath(testCaller({ userId: "u2" }), sessionId))).toBe(
      "not_found",
    );
    expect(await bed.service.laneProbe.agentText("nope", 10)).toBeNull();
    // An answer older than `since` is an earlier run's, not this task's (the fixture's assistant messages are stamped 2).
    expect(await bed.service.laneProbe.agentText(sessionId, 100, 2)).toBe("the last answer");
    expect(await bed.service.laneProbe.agentText(sessionId, 100, 3)).toBeNull();
  });
});

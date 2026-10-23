import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSessionCwd } from "./cwd.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { codeOf } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const ID = "atlas-1a2b";
let root: string;
let papHome: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-cwd-m11-")));
  papHome = join(root, "pap");
  for (const dir of [`agents/${ID}/sub`, "agents/.runs/x-0000/t", "worktrees/lane"])
    mkdirSync(join(papHome, dir), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const throwsWith = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code: string }).code;
  }
};

describe("resolveSessionCwd and the agents folder (M11R179, RT-12)", () => {
  it.each([
    ["an agent's home", () => join(papHome, "agents", ID)],
    ["a folder inside it", () => join(papHome, "agents", ID, "sub")],
    ["a scratch folder", () => join(papHome, "agents", ".runs", "x-0000", "t")],
    ["the agents folder itself", () => join(papHome, "agents")],
  ])("refuses %s", (_name, path) => {
    expect(throwsWith(() => resolveSessionCwd(path(), papHome))).toBe("invalid_cwd");
  });

  it("refuses the same folders through a linked $PAP_HOME spelling and through a link to them", () => {
    const spelled = join(root, "pap-link");
    symlinkSync(papHome, spelled);
    expect(throwsWith(() => resolveSessionCwd(join(spelled, "agents", ID), papHome))).toBe("invalid_cwd");
    const direct = join(root, "to-home");
    symlinkSync(join(papHome, "agents", ID), direct);
    expect(throwsWith(() => resolveSessionCwd(direct, papHome))).toBe("invalid_cwd");
    expect(throwsWith(() => resolveSessionCwd(join(papHome, "agents", ID), spelled))).toBe("invalid_cwd");
  });

  it("leaves a lane's worktree and other folders alone", () => {
    const lane = join(papHome, "worktrees", "lane");
    expect(resolveSessionCwd(lane, papHome)).toBe(lane);
    expect(resolveSessionCwd(root, papHome)).toBe(root);
  });
});

describe("sessions.create, fork and clone", () => {
  const build = (options?: BedOptions) =>
    createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
  let bed: ReturnType<typeof build>;
  afterEach(() => bed.dispose());

  it("sessions.create in an agent home is invalid_cwd, nothing starts", async () => {
    bed = build();
    const home = join(bed.dir, "pap", "agents", ID);
    mkdirSync(home, { recursive: true });
    expect(await codeOf(bed.service.create(home, OWNER))).toBe("invalid_cwd");
    expect(bed.spawned).toHaveLength(0);
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(sessionId).toBeTruthy();
  });

  it("fork and clone of an agent session answer bad_request; a plain session is judged as before", async () => {
    bed = build();
    mkdirSync(join(bed.dir, "pap", "agents", ID), { recursive: true, mode: 0o700 });
    bed.service.agent.setAgentPorts({
      agents: {
        profileOf: () => ({ input: AgentInput.parse({ name: "Atlas" }), name: "Atlas", quarantined: false }),
      },
    });
    const { sessionId } = await bed.service.agentSessions.createAgentSession({
      ownerId: "u1",
      agentId: ID,
      role: "thread",
    });
    expect(await codeOf(bed.service.fork({ sessionId, entryId: "e1" }, OWNER))).toBe("bad_request");
    expect(await codeOf(bed.service.clone({ sessionId }, OWNER))).toBe("bad_request");
    const plain = await bed.service.create(bed.work, OWNER);
    expect(await codeOf(bed.service.clone({ sessionId: plain.sessionId }, OWNER))).toBe("session_empty");
  });
});

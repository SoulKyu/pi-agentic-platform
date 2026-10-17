import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentInput, type ToolPreset } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { initRecordOf } from "./testing/fake-policy.ts";
import { codeOf } from "./testing/helpers.ts";
import { type BedOptions, type BedReply, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const ID = "atlas-1a2b";
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());
/** How the workers answer `set_tools`: a test may change it between two calls. */
let replies: { set_tools: BedReply };
const build = (options: BedOptions = {}) => {
  replies = { set_tools: { success: true } };
  return createServiceBed(
    { createSessionsStore, createSessionsService, loadTranscriptReader },
    { replies, ...options },
  );
};
const USABLE = { usable: true, path: "/usr/bin/bwrap" } as const;

/** A thread whose profile has `preset`; `profile.preset` can be edited while it runs. */
async function thread(preset: ToolPreset, options: BedOptions = {}, ensure = async () => USABLE) {
  bed = build(options);
  mkdirSync(join(bed.dir, "pap", "agents", ID), { recursive: true, mode: 0o700 });
  const profile = { preset };
  bed.service.agent.setAgentPorts({
    agents: {
      profileOf: () => ({
        input: AgentInput.parse({ name: "Atlas", preset: profile.preset }),
        name: "Atlas",
        quarantined: false,
      }),
      probe: { ensure },
    },
  });
  const { sessionId } = await bed.service.agentSessions.createAgentSession({
    ownerId: "u1",
    agentId: ID,
    role: "thread",
  });
  const release = async (index: number) => {
    expect(bed.service.agentSessions.releaseIdle("u1", sessionId)).toBe("released");
    await bed.spawned[index]?.exited;
  };
  /** An idle release, then a wake: the preset the next worker starts with. */
  const cycle = async (index: number) => {
    await release(index);
    await bed.service.reopen(sessionId, OWNER);
    return initPreset(index + 1);
  };
  return { sessionId, profile, release, cycle };
}
const initPreset = (index: number) => initRecordOf(bed.spawned[index]).tools?.preset;
const lastSetTools = (index: number) =>
  bed.spawned[index]?.requests.filter((request) => request.type === "set_tools").at(-1);

describe("the owner's preset on an agent thread (W5-R28)", () => {
  it("a narrowing set while the worker is down is still there after the reopen", async () => {
    const { sessionId, release } = await thread("default");
    await release(0);
    await bed.service.setTools({ sessionId, preset: "read-only" }, OWNER);
    await bed.service.reopen(sessionId, OWNER);
    expect(initPreset(1)).toBe("read-only");
    expect(bed.store.get(sessionId)?.ownerPreset).toBe("read-only");
  });

  it("a running narrowing to chat survives its own restart", async () => {
    const { sessionId } = await thread("default");
    await bed.service.setTools({ sessionId, preset: "chat" }, OWNER);
    await bed.spawned[0]?.exited;
    await bed.service.reopen(sessionId, OWNER);
    expect(initPreset(1)).toBe("chat");
  });

  it("without a choice of the owner's, a widened profile applies at the next start", async () => {
    const { sessionId, profile, release } = await thread("default");
    expect(initPreset(0)).toBe("default");
    profile.preset = "full";
    await release(0);
    await bed.service.reopen(sessionId, OWNER);
    expect(initPreset(1)).toBe("full");
    expect(bed.store.get(sessionId)?.ownerPreset).toBeUndefined();
  });

  it("with a choice, a widened profile does not widen the thread, and a narrowed one narrows it", async () => {
    const { sessionId, profile, release } = await thread("full");
    await bed.service.setTools({ sessionId, preset: "default" }, OWNER);
    profile.preset = "full";
    await release(0);
    await bed.service.reopen(sessionId, OWNER);
    expect(initPreset(1)).toBe("default");
    profile.preset = "read-only";
    await release(1);
    await bed.service.reopen(sessionId, OWNER);
    expect(initPreset(2)).toBe("read-only");
    expect(bed.store.get(sessionId)?.ownerPreset).toBe("default");
  });

  it("configured against a full profile clamps to the profile, and the choice is kept", async () => {
    const { sessionId } = await thread("full");
    await bed.service.setTools({ sessionId, preset: "configured" }, OWNER);
    expect(bed.store.toolPreset(sessionId)).toBe("full");
    expect(bed.store.get(sessionId)?.ownerPreset).toBe("configured");
  });

  it("follows the strict order: chat is narrower than none", async () => {
    const { sessionId } = await thread("none");
    await bed.service.setTools({ sessionId, preset: "chat" }, OWNER);
    await bed.spawned[0]?.exited;
    expect(bed.store.toolPreset(sessionId)).toBe("chat");
  });

  it("and a chat profile stays chat whatever the owner picks", async () => {
    const { sessionId } = await thread("chat");
    await bed.service.setTools({ sessionId, preset: "none" }, OWNER);
    expect(bed.store.toolPreset(sessionId)).toBe("chat");
  });

  it("a plain session has no owner preset: its choice is its preset, as before", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await bed.service.setTools({ sessionId, preset: "read-only" }, OWNER);
    expect(bed.store.toolPreset(sessionId)).toBe("read-only");
    expect(bed.store.get(sessionId)?.ownerPreset).toBeUndefined();
  });
});

describe("only a change that took effect is the owner's choice (W5-R28)", () => {
  it("a change refused as busy is forgotten: the next start keeps the earlier choice", async () => {
    const { sessionId, cycle } = await thread("full");
    await bed.service.setTools({ sessionId, preset: "read-only" }, OWNER);
    bed.emit(0, { type: "agent_start" });
    expect(await codeOf(bed.service.setTools({ sessionId, preset: "default" }, OWNER))).toBe("session_busy");
    expect(bed.store.get(sessionId)?.ownerPreset).toBe("read-only");
    bed.emit(0, { type: "agent_settled", aborted: false });
    await bed.clock.advance(0);
    expect(await cycle(0)).toBe("read-only");
  });

  it("a change the worker refused is forgotten too", async () => {
    const { sessionId, cycle } = await thread("full");
    await bed.service.setTools({ sessionId, preset: "read-only" }, OWNER);
    replies.set_tools = { success: false, error: "no such tool" };
    expect(await codeOf(bed.service.setTools({ sessionId, preset: "default" }, OWNER))).toBe(
      "command_failed",
    );
    expect(bed.store.get(sessionId)?.ownerPreset).toBe("read-only");
    expect(bed.store.toolPreset(sessionId)).toBe("read-only");
    expect(await cycle(0)).toBe("read-only");
  });

  it("then the same change, once it goes through, is the one the next start keeps", async () => {
    const { sessionId, cycle } = await thread("full");
    await bed.service.setTools({ sessionId, preset: "read-only" }, OWNER);
    replies.set_tools = { success: false, error: "no such tool" };
    await codeOf(bed.service.setTools({ sessionId, preset: "default" }, OWNER));
    replies.set_tools = { success: true };
    await bed.service.setTools({ sessionId, preset: "default" }, OWNER);
    expect(lastSetTools(0)).toMatchObject({ preset: "default" });
    expect(await cycle(0)).toBe("default");
    expect(bed.store.get(sessionId)?.ownerPreset).toBe("default");
  });
});

describe("a start reads the owner's choice as it starts (W5-R28)", () => {
  it("a choice set while the last worker is still exiting is the one the reopen uses", async () => {
    const { sessionId } = await thread("full", { holdShutdown: true });
    expect(bed.service.agentSessions.releaseIdle("u1", sessionId)).toBe("released");
    // The reopen has read the row and waits for the old worker's exit: the owner's choice lands in between.
    const reopened = bed.service.reopen(sessionId, OWNER);
    await bed.service.setTools({ sessionId, preset: "read-only" }, OWNER);
    bed.spawned[0]?.crash({ code: 0, signal: null, cause: "clean" });
    await reopened;
    expect(initPreset(1)).toBe("read-only");
    expect(bed.store.toolPreset(sessionId)).toBe("read-only");
  });

  it("a change asked during a start is clamped by the profile that start used (W5-R26)", async () => {
    let probed: Promise<void> = Promise.resolve();
    let open = () => {};
    const { sessionId, profile, release } = await thread("default", {}, async () => {
      await probed;
      return USABLE;
    });
    await release(0);
    probed = new Promise((resolve) => (open = resolve));
    // The gate has read the `default` profile and waits for the probe; the profile is widened before the owner asks.
    const reopened = bed.service.reopen(sessionId, OWNER);
    profile.preset = "full";
    const asked = bed.service.setTools({ sessionId, preset: "full" }, OWNER);
    open();
    await reopened;
    await asked;
    expect(lastSetTools(1)).toMatchObject({ preset: "default" });
    expect(bed.store.toolPreset(sessionId)).toBe("default");
    expect(bed.store.get(sessionId)?.ownerPreset).toBe("full");
  });
});

import type { Permission } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createLaunchLog } from "./launch-log.ts";
import { createKataBuild } from "./kata-build.ts";
import { createStderrRedactor } from "./stderr-redactor.ts";
import { createFakeVmd } from "./testing/fake-vmd.ts";

const OWNER = "owner-1";
const MEMBER = "member-2";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const VAULT_VALUE = "vault-value-1234567890";
const PROFILE = `pap-agent-profile-${"1".repeat(64)}`;
const WANTED = `pap-agent-agent-${"2".repeat(64)}`;
const callerOf = (userId: string, ...permissions: Permission[]) => ({
  userId,
  permissions: new Set<Permission>(permissions),
});

async function building() {
  const clock = createFakeClock();
  const vmd = createFakeVmd();
  vmd.handle("image.progress", (request) => ({
    building: request.op === "image.progress" && request.tag === PROFILE,
    lines: 2,
    last: { line: "#7 done", at: 1 },
    ...(request.op === "image.progress" && request.tag === PROFILE
      ? { tail: ["#6 RUN echo", `#7 export TOKEN=${VAULT_VALUE}`] }
      : {}),
  }));
  let release = (): void => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const build = createKataBuild({
    client: vmd,
    clock,
    logger: silentLogger,
    redact: createStderrRedactor({ clock, collect: async () => ({ secrets: [VAULT_VALUE] }) }),
    buildOnce: () => held,
    profileTag: () => PROFILE,
    runningTags: () => [],
    held: () => [],
    latest: new Map(),
  });
  const done = build.buildLayers({ tag: PROFILE }, "base", WANTED, [], new Set(), {
    observe: undefined,
    boxId: PROJECT,
  });
  await clock.advance(0);
  const log = createLaunchLog();
  log.bind({ projectOwner: (id) => (id === PROJECT ? OWNER : null), buildLog: build.tailOf });
  return { log, finish: async () => (release(), done) };
}

describe("launches.log", () => {
  it("a build line with a vault value reaches the web redacted", async () => {
    const { log, finish } = await building();
    const answer = await log.read(callerOf(OWNER, "sessions:read"), { kind: "project", id: PROJECT });
    expect(answer.lines).toEqual(["#6 RUN echo", "#7 export TOKEN=[REDACTED]"]);
    expect(JSON.stringify(answer)).not.toContain(VAULT_VALUE);
    await finish();
  });

  it("a member cannot read another user's box log", async () => {
    const { log, finish } = await building();
    await expect(
      log.read(callerOf(MEMBER, "sessions:read", "agents:read"), { kind: "project", id: PROJECT }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      log.read(callerOf(MEMBER, "sessions:read", "agents:read"), { kind: "agent", id: "helper-1a2b" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await finish();
  });

  it("asks agents:read for an agent box and sessions:read for a project box", async () => {
    const { log, finish } = await building();
    log.bindAgentOwner((id) => (id === "helper-1a2b" ? OWNER : null));
    await expect(
      log.read(callerOf(OWNER, "sessions:read"), { kind: "agent", id: "helper-1a2b" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      log.read(callerOf(OWNER, "agents:read"), { kind: "project", id: PROJECT }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      log.read(callerOf(OWNER, "agents:read"), { kind: "agent", id: "helper-1a2b" }),
    ).resolves.toEqual({ lines: [] });
    await finish();
  });
});

import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PolicyRules } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";

// W5-R63 (owner, M11a final review I3): in an agent thread Pi's file tools read the agent's home, the files attached to
// that thread and the system folders of its sandbox view, and nothing else, in every mode. Blocked, never asked.
const SESSION = "sess-atlas-thread";
const MODES = ["read-only", "supervised", "auto-accept-edits", "full-access"] as const;
let bed: Awaited<ReturnType<typeof createPipelineBed>>;
let atlas: string;
let scout: string;
let ownerHome: string;
let attachment: string;

beforeEach(async () => {
  bed = await createPipelineBed();
  ownerHome = join(bed.base, "home");
  vi.stubEnv("HOME", ownerHome);
  atlas = join(bed.papHome, "agents", "atlas-1a2b");
  scout = join(bed.papHome, "agents", "scout-0000");
  const mine = join(bed.papHome, "attachments", SESSION);
  attachment = join(mine, "note.txt");
  for (const dir of [atlas, scout, join(ownerHome, ".ssh"), mine, join(bed.papHome, "attachments", "other")])
    await mkdir(dir, { recursive: true });
  for (const dir of [join(runs("atlas-1a2b"), "t1"), join(runs("scout-0000"), "t1")])
    await mkdir(dir, { recursive: true });
  await writeFile(join(runs("atlas-1a2b"), "t1", "out.txt"), "run output");
  await writeFile(join(runs("scout-0000"), "t1", "out.txt"), "scout run");
  await writeFile(join(atlas, "a.txt"), "home notes");
  await writeFile(join(scout, "MEMORY.md"), "x");
  await writeFile(join(ownerHome, ".ssh", "id_x"), "key");
  await writeFile(attachment, "attached");
  await writeFile(join(bed.papHome, "attachments", "other", "o.txt"), "x");
  await symlink(join(ownerHome, ".ssh"), join(atlas, "link"), "dir");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await bed.dispose();
});

const runs = (agent: string) => join(bed.papHome, "agents", ".runs", agent);

const thread = (approvalMode: (typeof MODES)[number]) =>
  PolicyRules.parse({
    profile: "agent-thread",
    approvalMode,
    agentHome: atlas,
    sandbox: { required: true, network: false },
  });
const run = async (mode: (typeof MODES)[number], tool: string, input: unknown) => {
  const h = bed.harness({ cwd: atlas, rules: () => thread(mode), sessionId: SESSION });
  return { result: await h.run(tool, input), h };
};

describe("an agent thread's file tools stay in its folder (W5-R63)", () => {
  it.each(MODES)("blocks the owner's keys in %s, without a question", async (mode) => {
    for (const [tool, input] of [
      ["read", { path: join(ownerHome, ".ssh", "id_x") }],
      ["read", { path: "~/.ssh/id_x" }],
      ["ls", { path: ownerHome }],
      ["grep", { pattern: "key", path: ownerHome }],
      ["find", { pattern: "id_x", path: ownerHome }],
      ["read", { path: join(atlas, "link", "id_x") }],
    ] as const) {
      const { result, h } = await run(mode, tool, input);
      expect(result, `${mode} ${tool} ${JSON.stringify(input)}`).toMatchObject({ block: true });
      expect(h.asks).toHaveLength(0);
      expect(h.entries[0]).toMatchObject({ decision: "block", reason: "outside this agent's folder" });
    }
  });

  it.each(MODES)("blocks another agent's home, the other attachments and pap's files in %s", async (mode) => {
    for (const path of [
      join(scout, "MEMORY.md"),
      join(bed.papHome, "attachments", "other", "o.txt"),
      join(bed.papHome, "state.db"),
      join(runs("scout-0000"), "t1", "out.txt"),
      "/",
      "/var/tmp",
    ]) {
      const { result, h } = await run(mode, "read", { path });
      expect(result, `${mode} ${path}`).toMatchObject({ block: true });
      expect(h.asks).toHaveLength(0);
    }
    expect((await run(mode, "grep", { pattern: "x", path: bed.papHome })).result).toMatchObject({
      block: true,
    });
  });

  it.each(MODES)("lets the home, the thread's attachment and the system view be read in %s", async (mode) => {
    for (const [tool, input] of [
      ["read", { path: join(atlas, "a.txt") }],
      ["read", { path: "a.txt" }],
      ["ls", {}],
      ["grep", { pattern: "home" }],
      ["find", { pattern: "*.txt" }],
      ["read", { path: attachment }],
      ["ls", { path: join(bed.papHome, "attachments", SESSION) }],
      ["read", { path: join(runs("atlas-1a2b"), "t1", "out.txt") }],
      ["ls", { path: runs("atlas-1a2b") }],
      ["read", { path: "/etc/os-release" }],
      ["ls", { path: "/etc" }],
      ["grep", { pattern: "NAME", path: "/etc/os-release" }],
    ] as const) {
      const { result, h } = await run(mode, tool, input);
      expect(result, `${mode} ${tool} ${JSON.stringify(input)}`).toBeUndefined();
      expect(h.asks).toHaveLength(0);
    }
  });
});

describe("a path that does not exist is judged by its nearest existing parent (W5-R65)", () => {
  it.each(MODES)("lets a missing file in the home or the own runs folder through in %s", async (mode) => {
    for (const path of [
      join(atlas, "missing.txt"),
      join(atlas, "no", "such", "dir", "f"),
      join(runs("atlas-1a2b"), "t1", "nope"),
    ]) {
      const { result, h } = await run(mode, "read", { path });
      expect(result, `${mode} ${path}`).toBeUndefined();
      expect(h.asks).toHaveLength(0);
    }
  });

  it.each(MODES)(
    "still blocks a missing file under ~/.ssh, another home and a link out of the home in %s",
    async (mode) => {
      for (const path of [
        join(ownerHome, ".ssh", "missing"),
        join(scout, "missing.md"),
        join(runs("scout-0000"), "t1", "nope"),
        join(atlas, "link", "missing"),
      ]) {
        const { result } = await run(mode, "read", { path });
        expect(result, `${mode} ${path}`).toMatchObject({ block: true });
      }
    },
  );
});

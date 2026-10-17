import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPrompts } from "./prompts.ts";
import { agentInput, type AgentsBed, createAgentsBed } from "./testing/bed.ts";
import { bedHelpers } from "./testing/helpers.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());
const { refusalOf } = bedHelpers(() => bed);

async function world() {
  bed = createAgentsBed();
  const { id } = await bed.agents.create(bed.owner(), agentInput());
  const home = join(bed.papHome, "agents", id);
  const prompts = join(home, "prompts");
  mkdirSync(prompts, { recursive: true, mode: 0o700 });
  const service = createPrompts({ store: bed.agents.store, papHome: bed.papHome });
  return { id, home, prompts, service };
}

describe("agents.prompts and agents.prompt (M11R186)", () => {
  it("lists nothing when the home has no prompts folder", async () => {
    const { id, prompts, service } = await world();
    rmSync(prompts, { recursive: true });
    expect(service.list(bed.owner(), id)).toEqual({ names: [] });
  });

  it("lists at most 12 .md names, sorted, files only", async () => {
    const { id, prompts, service } = await world();
    for (let n = 13; n >= 1; n -= 1)
      writeFileSync(join(prompts, `p${String(n).padStart(2, "0")}.md`), `t${n}`);
    writeFileSync(join(prompts, "notes.txt"), "x");
    mkdirSync(join(prompts, "dir.md"));
    writeFileSync(join(prompts, "has space.md"), "x");
    writeFileSync(join(prompts, ".hidden.md"), "x");
    const { names } = service.list(bed.owner(), id);
    expect(names).toHaveLength(12);
    expect(names).toEqual([...names].sort());
    expect(names[0]).toBe("p01.md");
    expect(names).not.toContain("notes.txt");
    expect(names).not.toContain("dir.md");
    expect(names).not.toContain("has space.md");
    expect(names).not.toContain(".hidden.md");
  });

  it("reads the text of a prompt", async () => {
    const { id, prompts, service } = await world();
    writeFileSync(join(prompts, "daily.md"), "Summarise événements\nof today");
    expect(service.read(bed.owner(), id, "daily.md")).toEqual({ text: "Summarise événements\nof today" });
  });

  it("skips a link named x.md in the list and refuses it in the read: the target is never opened", async () => {
    const { id, prompts, service } = await world();
    const outside = join(bed.dir, "user", ".ssh");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "id"), "PRIVATE-KEY-MATERIAL");
    symlinkSync(join(outside, "id"), join(prompts, "x.md"));
    writeFileSync(join(prompts, "ok.md"), "fine");
    expect(service.list(bed.owner(), id).names).toEqual(["ok.md"]);
    const attempt = (): string => {
      try {
        return JSON.stringify(service.read(bed.owner(), id, "x.md"));
      } catch (error) {
        return String((error as Error).message);
      }
    };
    expect(attempt()).not.toContain("PRIVATE-KEY-MATERIAL");
    expect(await refusalOf(() => service.read(bed.owner(), id, "x.md"))).toBe("not_found");
  });

  it("a prompts folder that is a link lists nothing and reads nothing", async () => {
    const { id, prompts, service } = await world();
    const outside = join(bed.dir, "elsewhere");
    mkdirSync(outside);
    writeFileSync(join(outside, "stolen.md"), "STOLEN");
    rmSync(prompts, { recursive: true });
    symlinkSync(outside, prompts);
    expect(service.list(bed.owner(), id)).toEqual({ names: [] });
    expect(await refusalOf(() => service.read(bed.owner(), id, "stolen.md"))).toBe("not_found");
  });

  it("a pipe named p.md is skipped by the list and never blocks the read", async () => {
    const { id, prompts, service } = await world();
    execFileSync("mkfifo", [join(prompts, "pipe.md")]);
    expect(service.list(bed.owner(), id).names).toEqual([]);
    expect(await refusalOf(() => service.read(bed.owner(), id, "pipe.md"))).toBe("not_found");
  });

  it("refuses a file over 16 KiB and accepts exactly 16 KiB", async () => {
    const { id, prompts, service } = await world();
    writeFileSync(join(prompts, "big.md"), "a".repeat(17 * 1024));
    writeFileSync(join(prompts, "edge.md"), "a".repeat(16 * 1024));
    expect(await refusalOf(() => service.read(bed.owner(), id, "big.md"))).toBe("payload_too_large");
    expect(service.read(bed.owner(), id, "edge.md").text).toHaveLength(16 * 1024);
  });

  it("refuses text that is not UTF-8", async () => {
    const { id, prompts, service } = await world();
    writeFileSync(join(prompts, "bin.md"), Buffer.from([0xff, 0xfe, 0x41]));
    expect(await refusalOf(() => service.read(bed.owner(), id, "bin.md"))).toBe("bad_request");
  });

  it("refuses a name that is not one file name directly under prompts/", async () => {
    const { id, service } = await world();
    for (const name of [
      "../x",
      "../x.md",
      "a/b.md",
      "..",
      ".md",
      "x",
      "x.txt",
      "a\u0000.md",
      "",
      "x".repeat(70) + ".md",
    ])
      expect(await refusalOf(() => service.read(bed.owner(), id, name))).toBe("bad_request");
  });

  it("is not_found for a missing prompt", async () => {
    const { id, service } = await world();
    expect(await refusalOf(() => service.read(bed.owner(), id, "nope.md"))).toBe("not_found");
  });

  it("is not_found for another owner's agent, in both reads", async () => {
    const { id, prompts, service } = await world();
    writeFileSync(join(prompts, "a.md"), "x");
    const other = bed.owner({ userId: "u2" });
    expect(await refusalOf(() => service.list(other, id))).toBe("not_found");
    expect(await refusalOf(() => service.read(other, id, "a.md"))).toBe("not_found");
  });

  it("is invalid_cwd when the home was replaced by a link", async () => {
    const { id, home, prompts, service } = await world();
    writeFileSync(join(prompts, "a.md"), "x");
    const moved = join(bed.dir, "moved");
    renameSync(home, moved);
    symlinkSync(moved, home);
    expect(await refusalOf(() => service.list(bed.owner(), id))).toBe("invalid_cwd");
    expect(await refusalOf(() => service.read(bed.owner(), id, "a.md"))).toBe("invalid_cwd");
  });

  it("a token with agents:read may read (the chips are the owner's own files)", async () => {
    const { id, prompts, service } = await world();
    writeFileSync(join(prompts, "a.md"), "x");
    expect(service.list(bed.owner({ kind: "token" }), id).names).toEqual(["a.md"]);
  });

  it("scans a crowded folder without reading it all: still 12 names at most (m5)", async () => {
    const { id, prompts, service } = await world();
    for (let n = 0; n < 600; n += 1) writeFileSync(join(prompts, `f${n}.md`), "x");
    const { names } = service.list(bed.owner(), id);
    expect(names).toHaveLength(12);
    expect(names).toEqual([...names].sort());
  });
});

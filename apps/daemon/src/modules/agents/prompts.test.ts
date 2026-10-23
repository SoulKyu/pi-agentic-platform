import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentFiles } from "../agent-vm/index.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createPrompts } from "./prompts.ts";
import { agentInput, type AgentsBed, createAgentsBed } from "./testing/bed.ts";
import { bedHelpers } from "./testing/helpers.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());
const { refusalOf } = bedHelpers(() => bed);

async function world() {
  bed = createAgentsBed();
  const { id } = await bed.agents.create(bed.owner(), agentInput());
  const files = createAgentFiles({ secretsDir: join(bed.dir, "secrets"), logger: captureLogger().logger });
  const put = (path: string, content: string | Buffer): void => {
    files.put(id, path, Buffer.from(content));
  };
  return { id, put, service: createPrompts({ store: bed.agents.store, files }) };
}

describe("agents.prompts and agents.prompt from the imported files", () => {
  it("lists nothing when no prompt was imported", async () => {
    const { id, service } = await world();
    expect(service.list(bed.owner(), id)).toEqual({ names: [] });
  });

  it("lists at most 12 .md names, sorted, directly under prompts/ only", async () => {
    const { id, put, service } = await world();
    for (let n = 13; n >= 1; n -= 1) put(`prompts/p${String(n).padStart(2, "0")}.md`, `t${n}`);
    put("prompts/notes.txt", "x");
    put("prompts/sub/x.md", "x");
    put("notes.md", "x");
    const { names } = service.list(bed.owner(), id);
    expect(names).toHaveLength(12);
    expect(names).toEqual([...names].sort());
    expect(names[0]).toBe("p01.md");
    for (const other of ["notes.txt", "x.md", "notes.md"]) expect(names).not.toContain(other);
  });

  it("reads the text of a prompt", async () => {
    const { id, put, service } = await world();
    put("prompts/daily.md", "Summarise événements\nof today");
    expect(await service.read(bed.owner(), id, "daily.md")).toEqual({
      text: "Summarise événements\nof today",
    });
  });

  it("refuses a file over 16 KiB and accepts exactly 16 KiB", async () => {
    const { id, put, service } = await world();
    put("prompts/big.md", "a".repeat(17 * 1024));
    put("prompts/edge.md", "a".repeat(16 * 1024));
    expect(await refusalOf(() => service.read(bed.owner(), id, "big.md"))).toBe("payload_too_large");
    expect((await service.read(bed.owner(), id, "edge.md")).text).toHaveLength(16 * 1024);
  });

  it("refuses text that is not UTF-8", async () => {
    const { id, put, service } = await world();
    put("prompts/bin.md", Buffer.from([0xff, 0xfe, 0x41]));
    expect(await refusalOf(() => service.read(bed.owner(), id, "bin.md"))).toBe("bad_request");
  });

  it("refuses a name that is not one file name directly under prompts/", async () => {
    const { id, service } = await world();
    for (const name of [
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

  it("a pipe named p.md does not hang the read: not_found", async () => {
    const { id, put, service } = await world();
    put("prompts/a.md", "x");
    execFileSync("mkfifo", [join(bed.dir, "secrets", "agent-files", id, "prompts", "pipe.md")]);
    expect(await refusalOf(() => service.read(bed.owner(), id, "pipe.md"))).toBe("not_found");
  });

  it("is not_found for a missing prompt", async () => {
    const { id, service } = await world();
    expect(await refusalOf(() => service.read(bed.owner(), id, "nope.md"))).toBe("not_found");
  });

  it("is not_found for another owner's agent, in both reads", async () => {
    const { id, put, service } = await world();
    put("prompts/a.md", "x");
    const other = bed.owner({ userId: "u2" });
    expect(await refusalOf(async () => service.list(other, id))).toBe("not_found");
    expect(await refusalOf(() => service.read(other, id, "a.md"))).toBe("not_found");
  });

  it("a token with agents:read may read (the chips are the owner's own files)", async () => {
    const { id, put, service } = await world();
    put("prompts/a.md", "x");
    expect(service.list(bed.owner({ kind: "token" }), id).names).toEqual(["a.md"]);
  });
});

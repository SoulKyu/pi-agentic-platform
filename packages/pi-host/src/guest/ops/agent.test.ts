import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoxOp } from "@pap/contracts/pi-host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentGuestOps } from "./agent.ts";

let root: string;
let ops: ReturnType<typeof createAgentGuestOps>;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-agent-ops-")));
  for (const dir of ["home", "inbox", "knowledge", ".pi", "lost+found"]) mkdirSync(join(root, dir));
  writeFileSync(join(root, ".pi", "x"), "secret");
  writeFileSync(join(root, "lost+found", "y"), "lost");
  writeFileSync(join(root, "home", "readme.txt"), "hello");
  writeFileSync(join(root, ".pi", "readme.txt"), "secret");
  writeFileSync(join(root, "lost+found", "readme.txt"), "lost");
  ops = createAgentGuestOps(root, () => Date.now());
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const refusal = async (op: BoxOp) => {
  const answer = await ops(op);
  return answer.ok ? "answered" : answer.code;
};

describe("agent guest ops", () => {
  it("lists the root without .pi and lost+found", async () => {
    const answer = await ops({ name: "fs.list", path: root, showIgnored: true });
    if (!answer.ok) throw new Error(answer.code);
    const names = (answer.value as { entries: { name: string }[] }).entries.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(["home", "inbox", "knowledge"]));
    expect(names).not.toContain(".pi");
    expect(names).not.toContain("lost+found");
  });

  it("answers not_found for every file op on a hidden path", async () => {
    for (const hidden of [`${root}/.pi/x`, `${root}/.pi`, `${root}/lost+found/y`, `${root}/lost+found`]) {
      expect(await refusal({ name: "fs.read", path: hidden, offset: 0 }), hidden).toBe("not_found");
      expect(await refusal({ name: "fs.get", path: hidden, offset: 0 }), hidden).toBe("not_found");
      expect(await refusal({ name: "fs.write", path: hidden, text: "x", baseEtag: null }), hidden).toBe(
        "not_found",
      );
      expect(await refusal({ name: "fs.list", path: hidden, showIgnored: true }), hidden).toBe("not_found");
      expect(
        await refusal({
          name: "fs.put",
          id: "0".repeat(32),
          path: hidden,
          offset: 0,
          data: Buffer.from("x").toString("base64"),
          last: true,
          conflict: "replace",
        }),
        hidden,
      ).toBe("not_found");
    }
  });

  it.each([
    ["a trailing slash", (r: string) => `${r}/.pi/`],
    ["a double slash", (r: string) => `${r}//.pi`],
    ["a parent segment", (r: string) => `${r}/home/../.pi`],
    ["a dot segment", (r: string) => `${r}/./lost+found`],
  ])("answers not_found for a hidden folder spelled with %s", async (_label, spell) => {
    const hidden = spell(root);
    expect(await refusal({ name: "fs.read", path: hidden, offset: 0 })).toBe("not_found");
    expect(await refusal({ name: "fs.get", path: hidden, offset: 0 })).toBe("not_found");
    expect(await refusal({ name: "fs.write", path: hidden, text: "x", baseEtag: null })).toBe("not_found");
    expect(await refusal({ name: "fs.list", path: hidden, showIgnored: true })).toBe("not_found");
  });

  it("never returns hidden paths from a search", async () => {
    const answer = await ops({ name: "fs.search", query: "readme", limit: 50 });
    if (!answer.ok) throw new Error(answer.code);
    const { paths } = answer.value as { paths: string[] };
    expect(paths).toContain("home/readme.txt");
    expect(paths.some((p) => p.startsWith(".pi/") || p.startsWith("lost+found/"))).toBe(false);
  });

  it("refuses the project-only ops", async () => {
    for (const op of [
      { name: "git.status" },
      { name: "knowledge.state" },
      { name: "project.config" },
      { name: "github.token", token: "t", expiresAt: "2026-10-24T13:00:00Z" },
    ] as BoxOp[])
      expect(await refusal(op), op.name).toBe("not_found");
  });

  it("writes then reads a file in home", async () => {
    const path = `${root}/home/notes.md`;
    const written = await ops({ name: "fs.write", path, text: "hi", baseEtag: null });
    expect(written.ok).toBe(true);
    const answer = await ops({ name: "fs.read", path, offset: 0 });
    if (!answer.ok) throw new Error(answer.code);
    expect(JSON.stringify(answer.value)).toContain("hi");
  });

  it("leaves hidden folders out of the walk, so they cannot fill the limit", async () => {
    for (let i = 0; i < 20; i++) writeFileSync(join(root, ".pi", `needle-${i}.txt`), "x");
    writeFileSync(join(root, "home", "needle-visible.txt"), "x");
    const answer = await ops({ name: "fs.search", query: "needle", limit: 5 });
    if (!answer.ok) throw new Error(answer.code);
    expect(answer.value).toEqual({ paths: ["home/needle-visible.txt"], truncated: false });
  });
});

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableKnowledge, hasKnowledge, knowledgeOf } from "./knowledge.ts";

const NOW = new Date("2026-10-23T08:00:00Z");
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-okf-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const bundle = (index = 'okf_version: "0.2"\n') => {
  mkdirSync(join(root, "knowledge"));
  writeFileSync(join(root, "knowledge", "index.md"), index);
};

describe("knowledgeOf", () => {
  it("is present for a regular index.md that carries okf_version", () => {
    bundle();
    expect(knowledgeOf(root)).toEqual({ enabled: true, concepts: 0 });
  });

  it("is absent without a knowledge folder", () => {
    expect(knowledgeOf(root)).toEqual({ enabled: false, concepts: 0 });
  });

  it("accepts any 0.x version and a frontmatter line", () => {
    bundle('---\nokf_version: "0.3"\n---\n');
    expect(knowledgeOf(root).enabled).toBe(true);
  });

  it("is absent for an index.md without okf_version or with another major", () => {
    bundle("# notes\n");
    expect(knowledgeOf(root).enabled).toBe(false);
    writeFileSync(join(root, "knowledge", "index.md"), 'okf_version: "1.0"\n');
    expect(knowledgeOf(root).enabled).toBe(false);
  });

  it("only reads the first 512 bytes", () => {
    bundle(`${"x".repeat(600)}\nokf_version: "0.2"\n`);
    expect(knowledgeOf(root).enabled).toBe(false);
  });

  it("is absent when knowledge is a link", () => {
    mkdirSync(join(root, "elsewhere"));
    writeFileSync(join(root, "elsewhere", "index.md"), 'okf_version: "0.2"\n');
    symlinkSync(join(root, "elsewhere"), join(root, "knowledge"));
    expect(knowledgeOf(root).enabled).toBe(false);
  });

  it("is absent when knowledge is a file", () => {
    writeFileSync(join(root, "knowledge"), 'okf_version: "0.2"\n');
    expect(knowledgeOf(root).enabled).toBe(false);
  });

  it("is absent when index.md is a link", () => {
    mkdirSync(join(root, "knowledge"));
    writeFileSync(join(root, "real.md"), 'okf_version: "0.2"\n');
    symlinkSync(join(root, "real.md"), join(root, "knowledge", "index.md"));
    expect(knowledgeOf(root).enabled).toBe(false);
  });

  it("is absent when index.md is a directory", () => {
    mkdirSync(join(root, "knowledge", "index.md"), { recursive: true });
    expect(knowledgeOf(root).enabled).toBe(false);
  });

  it("counts concept files, not index.md, log.md or links", () => {
    bundle();
    const dir = join(root, "knowledge");
    writeFileSync(join(dir, "log.md"), "## 2026-10-23\n");
    writeFileSync(join(dir, "a.md"), "a");
    writeFileSync(join(dir, "notes.txt"), "not a concept");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.md"), "b");
    symlinkSync(join(dir, "a.md"), join(dir, "link.md"));
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside", "c.md"), "c");
    symlinkSync(join(root, "outside"), join(dir, "linked-dir"));
    expect(knowledgeOf(root)).toEqual({ enabled: true, concepts: 2 });
  });
});

describe("hasKnowledge", () => {
  it("answers without walking and never throws", () => {
    expect(hasKnowledge(root)).toBe(false);
    bundle();
    expect(hasKnowledge(root)).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("reads an unopenable folder as absent and reports its code", () => {
    bundle();
    chmodSync(join(root, "knowledge"), 0o000);
    const codes: string[] = [];
    try {
      expect(hasKnowledge(root, (code) => codes.push(code))).toBe(false);
      expect(knowledgeOf(root)).toEqual({ enabled: false, concepts: 0 });
    } finally {
      chmodSync(join(root, "knowledge"), 0o755);
    }
    expect(codes).toEqual(["EACCES"]);
  });
});

describe("enableKnowledge", () => {
  it("creates index.md and log.md with the exact lines", () => {
    enableKnowledge(root, NOW);
    const index = readFileSync(join(root, "knowledge", "index.md"), "utf8");
    expect(index.split("\n").slice(0, 3)).toEqual(["---", 'okf_version: "0.2"', "---"]);
    expect(readFileSync(join(root, "knowledge", "log.md"), "utf8")).toBe("## 2026-10-23\n- OKF enabled\n");
    expect(knowledgeOf(root)).toEqual({ enabled: true, concepts: 0 });
  });

  it("is idempotent", () => {
    enableKnowledge(root, NOW);
    const index = readFileSync(join(root, "knowledge", "index.md"), "utf8");
    enableKnowledge(root, new Date("2026-11-01T00:00:00Z"));
    expect(readFileSync(join(root, "knowledge", "index.md"), "utf8")).toBe(index);
    expect(readFileSync(join(root, "knowledge", "log.md"), "utf8")).toBe("## 2026-10-23\n- OKF enabled\n");
  });

  it("refuses a knowledge link and writes nothing", () => {
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(root, "knowledge"));
    expect(() => enableKnowledge(root, NOW)).toThrow(PapError);
    expect(readdirSync(join(root, "elsewhere"))).toEqual([]);
  });

  it("refuses a knowledge file", () => {
    writeFileSync(join(root, "knowledge"), "mine");
    expect(() => enableKnowledge(root, NOW)).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(readFileSync(join(root, "knowledge"), "utf8")).toBe("mine");
  });

  it("refuses an index.md link and an index.md without okf_version, writing nothing", () => {
    mkdirSync(join(root, "knowledge"));
    writeFileSync(join(root, "real.md"), "x");
    symlinkSync(join(root, "real.md"), join(root, "knowledge", "index.md"));
    expect(() => enableKnowledge(root, NOW)).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(readFileSync(join(root, "real.md"), "utf8")).toBe("x");
    rmSync(join(root, "knowledge", "index.md"));
    writeFileSync(join(root, "knowledge", "index.md"), "# mine\n");
    expect(() => enableKnowledge(root, NOW)).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(readdirSync(join(root, "knowledge")).sort()).toEqual(["index.md"]);
  });

  it("never overwrites", () => {
    const mine = '---\nokf_version: "0.2"\ntitle: Mine\n---\nmy index\n';
    bundle(mine);
    enableKnowledge(root, NOW);
    expect(readFileSync(join(root, "knowledge", "index.md"), "utf8")).toBe(mine);
    expect(readFileSync(join(root, "knowledge", "log.md"), "utf8")).toBe("## 2026-10-23\n- OKF enabled\n");
  });

  it("does not create missing parents", () => {
    expect(() => enableKnowledge(join(root, "gone"), NOW)).toThrow();
  });
});

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templateText, writeTemplate } from "./prompt-template.ts";

let root: string;
let agentDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-tpl-"));
  agentDir = join(root, "agent");
  mkdirSync(agentDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const modeOf = (path: string) => statSync(path).mode & 0o777;

describe("writeTemplate", () => {
  it("writes <agent>/prompts/review.md, 0600, in a 0700 folder it creates", async () => {
    expect(await writeTemplate({ agentDir }, { name: "review", body: "Review $1\n" })).toEqual({
      replaced: false,
    });
    const file = join(agentDir, "prompts", "review.md");
    expect(readFileSync(file, "utf8")).toBe('---\ndescription: "Review $1"\n---\nReview $1\n');
    expect(modeOf(file)).toBe(0o600);
    expect(modeOf(join(agentDir, "prompts"))).toBe(0o700);
    expect(readdirSync(join(agentDir, "prompts"))).toEqual(["review.md"]);
  });

  it("Pi's loader lists the written template with its description and body", async () => {
    const body = "Do it\n---\nfoo: bar\n---\nrest\n";
    await writeTemplate({ agentDir }, { name: "review", description: 'a "b": #c --- d\\e', body });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const prompt = loader.getPrompts().prompts.find((p) => p.name === "review");
    expect(prompt).toMatchObject({ name: "review", description: 'a "b": #c --- d\\e' });
    expect(prompt?.content).toContain("---\nfoo: bar\n---");
  });

  it("no description: the first non-empty line, trimmed; a blank-looking first line falls back to the name", () => {
    expect(templateText("n", "\n  \n  Hello there  \nmore", undefined)).toBe(
      '---\ndescription: "Hello there"\n---\n\n  \n  Hello there  \nmore',
    );
    expect(templateText("n", "  \n\t", undefined)).toBe('---\ndescription: "n"\n---\n  \n\t');
    expect(templateText("n", "x", "")).toContain('description: "x"');
  });

  it("an agent dir that is itself a link works", async () => {
    const link = join(root, "link");
    symlinkSync(agentDir, link);
    await writeTemplate({ agentDir: link }, { name: "review", body: "x\n" });
    expect(readFileSync(join(agentDir, "prompts", "review.md"), "utf8")).toContain("x\n");
  });
});

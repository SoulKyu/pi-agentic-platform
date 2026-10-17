import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Does Pi 1.1.0's `grep`, `find` and `ls` follow a link the sandboxed shell planted in its scratch folder? Lane B's read
// boundaries depend on the answer (task-4 report). They need ripgrep and fd on PATH (Pi would download them otherwise).
const have = (tool: string): boolean => {
  try {
    execFileSync(tool, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const fdName = have("fd") ? "fd" : have("fdfind") ? "fdfind" : null;
const tools = have("rg") && fdName !== null;
if (!tools && process.env.CI) throw new Error("pi-search.symlinks.int.test: CI must provide ripgrep and fd");
if (!tools) console.warn("pi-search.symlinks.int.test: skipped: ripgrep or fd is not on PATH");

const MARKER = "OUTSIDE-MARKER-0123456789";

describe.skipIf(!tools)("Pi's search tools and a link planted in the scratch folder", () => {
  let root: string;
  let scratch: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pap-search-links-")));
    scratch = join(root, "scratch");
    mkdirSync(scratch);
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside", "secret.txt"), `${MARKER}\n`);
    writeFileSync(join(scratch, "real.txt"), "inside\n");
    symlinkSync(join(root, "outside"), join(scratch, "link-dir"));
    symlinkSync(join(root, "outside", "secret.txt"), join(scratch, "link-file.txt"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
    vi.stubEnv("PI_OFFLINE", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const text = (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content.map((block) => block.text ?? "").join("");
  const signal = new AbortController().signal;

  it("grep does not search through a linked folder or a linked file met while walking", async () => {
    const grep = createGrepToolDefinition(scratch);
    const result = await grep.execute("t", { pattern: MARKER }, signal, undefined, undefined as never);
    expect(text(result)).not.toContain(MARKER);
  });

  it("grep follows a link only when it is the path the call names (the policy judges that path before the tool runs)", async () => {
    const grep = createGrepToolDefinition(scratch);
    const result = await grep.execute(
      "t",
      { pattern: MARKER, path: join(scratch, "link-dir") },
      signal,
      undefined,
      undefined as never,
    );
    expect(text(result)).toContain(MARKER);
  });

  it("find lists a link as a name and does not walk into a linked folder", async () => {
    const find = createFindToolDefinition(scratch);
    const result = await find.execute("t", { pattern: "*.txt" }, signal, undefined, undefined as never);
    const listed = text(result);
    expect(listed).toContain("real.txt");
    expect(listed).not.toContain("secret.txt");
    expect(listed).not.toContain(MARKER);
  });

  it("ls names the entries of a folder and never reads through a link", async () => {
    const ls = createLsToolDefinition(scratch);
    const result = await ls.execute("t", {}, signal, undefined, undefined as never);
    expect(text(result)).not.toContain(MARKER);
    expect(text(result)).not.toContain("secret.txt");
  });
});

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostBed, isConfirm, toolScript, toolText } from "./testing/host-bed.ts";

// grep and find are "read" tools: the policy lets them through without asking. A model-chosen pattern or path that
// a search binary read as an option (`rg --pre`, `fd -x`) would run code with no approval at all. Each probe asks
// for exactly that and checks that nothing ran. The control tests show the probe script does run when the binary
// is given the option directly, so a passing probe cannot be a broken harness.
const hasBinary = (name: string) => spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0;
const HAS_RG = hasBinary("rg");
const HAS_FD = hasBinary("fd");

let bed: ReturnType<typeof createHostBed>;
let evil: string;
let marker: string;
beforeEach(() => {
  bed = createHostBed();
  evil = join(bed.root, "evil.sh");
  marker = join(bed.root, "PWNED");
  writeFileSync(evil, `#!/bin/sh\ntouch "${marker}"\ncat "$1"\n`);
  chmodSync(evil, 0o755);
  writeFileSync(join(bed.cwd, "a.txt"), "needle\n");
});
afterEach(() => bed.dispose());

async function probe(tool: string, args: Record<string, string>): Promise<string> {
  await bed.start(toolScript(tool, args), { settings: { defaultTools: ["+grep", "+find", "+ls"] } });
  const host = bed.host();
  await host.request({ type: "prompt", message: "go" });
  await host.waitFor((r) => r.type === "agent_settled");
  expect(host.records.some(isConfirm)).toBe(false);
  expect(host.records.find((r) => r.type === "audit")).toMatchObject({
    entry: { tool, category: "read", decision: "allow" },
  });
  const end = host.records.find((r) => r.type === "tool_execution_end");
  if (!end) throw new Error("the tool never ended");
  return toolText(end);
}

describe("the probe script", () => {
  it.skipIf(!HAS_RG)("runs when ripgrep is given --pre directly", () => {
    execFileSync("rg", ["--pre", evil, "needle", bed.cwd], { stdio: "ignore" });
    expect(existsSync(marker)).toBe(true);
  });

  it.skipIf(!HAS_FD)("runs when fd is given -x directly", () => {
    execFileSync("fd", ["--type", "f", "--exec", evil, ";", ".", bed.cwd], { stdio: "ignore" });
    expect(existsSync(marker)).toBe(true);
  });
});

describe.skipIf(!HAS_RG)("grep reads option-shaped arguments as data", () => {
  it.each([
    ["a pattern that is --pre", () => ({ pattern: `--pre=${evil}`, path: "." })],
    [
      "a pattern that is --pre with the script as the next word",
      () => ({ pattern: `--pre ${evil}`, path: "." }),
    ],
    ["a pattern that is -e", () => ({ pattern: "-e", path: "." })],
    ["a glob that is --pre", () => ({ pattern: "needle", glob: `--pre=${evil}` })],
  ])("%s", async (_name, args) => {
    expect(await probe("grep", args())).toContain("No matches found");
    expect(existsSync(marker)).toBe(false);
  });

  it("a path that is --pre", async () => {
    expect(await probe("grep", { pattern: "needle", path: `--pre=${evil}` })).toContain("Path not found");
    expect(existsSync(marker)).toBe(false);
  });

  it("still finds an ordinary match", async () => {
    expect(await probe("grep", { pattern: "needle", path: "." })).toContain("a.txt:1: needle");
  });
});

describe.skipIf(!HAS_FD)("find reads option-shaped arguments as data", () => {
  it.each([
    ["a pattern that is -x", () => ({ pattern: `-x${evil}`, path: "." })],
    ["a pattern that is --exec", () => ({ pattern: `--exec=${evil}`, path: "." })],
    ["a pattern that is -X", () => ({ pattern: `-X ${evil}`, path: "." })],
  ])("%s", async (_name, args) => {
    expect(await probe("find", args())).toContain("No files found");
    expect(existsSync(marker)).toBe(false);
  });

  it("a path that is -x", async () => {
    expect(await probe("find", { pattern: "*.txt", path: `-x${evil}` })).toContain("is not a directory");
    expect(existsSync(marker)).toBe(false);
  });

  it("still finds an ordinary file", async () => {
    expect(await probe("find", { pattern: "*.txt", path: "." })).toContain("a.txt");
  });
});

describe("ls reads an option-shaped path as data", () => {
  it("a path that is -la", async () => {
    expect(await probe("ls", { path: "-la" })).toContain("Path not found");
  });
});

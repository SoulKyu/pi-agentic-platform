import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type TestContext } from "vitest";
import { createHostBed, isApproval, isCallAudit, toolScript, toolText } from "./testing/host-bed.ts";

// grep and find are "read" tools: the policy lets them through without asking. A model-chosen pattern or path that
// a search binary read as an option (`rg --pre`, `fd -x`) would run code with no approval at all. Each probe asks
// for exactly that and checks that nothing ran. The control tests show the probe script does run when the binary
// is given the option directly, so a passing probe cannot be a broken harness.
const hasBinary = (name: string) => spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0;
const HAS_RG = hasBinary("rg");
const HAS_FD = hasBinary("fd");

// A skipped security probe passes silently, so in CI a missing binary fails the probes that need it (R92).
// On a developer machine the probe is skipped, and says why.
function needs(binary: string, present: boolean) {
  return (context: TestContext) => {
    if (present) return;
    if (process.env["CI"]) {
      throw new Error(
        `${binary} is not installed: the CI setup action must provide it, a probe may not be skipped`,
      );
    }
    context.skip(`${binary} is not installed`);
  };
}

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
  expect(host.records.some(isApproval)).toBe(false);
  expect(host.records.find(isCallAudit)).toMatchObject({
    entry: { tool, category: "read", decision: "allow" },
  });
  const end = host.records.find((r) => r.type === "tool_execution_end");
  if (!end) throw new Error("the tool never ended");
  return toolText(end);
}

describe("the probe script", () => {
  it("runs when ripgrep is given --pre directly", (context) => {
    needs("rg", HAS_RG)(context);
    execFileSync("rg", ["--pre", evil, "needle", bed.cwd], { stdio: "ignore" });
    expect(existsSync(marker)).toBe(true);
  });

  it("runs when fd is given -x directly", (context) => {
    needs("fd", HAS_FD)(context);
    execFileSync("fd", ["--type", "f", "--exec", evil, ";", ".", bed.cwd], { stdio: "ignore" });
    expect(existsSync(marker)).toBe(true);
  });
});

describe("grep reads option-shaped arguments as data", () => {
  beforeEach(needs("rg", HAS_RG));

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

describe("find reads option-shaped arguments as data", () => {
  beforeEach(needs("fd", HAS_FD));

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

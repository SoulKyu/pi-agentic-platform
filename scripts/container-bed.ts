import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];

/** Call from an `afterEach`: removes every sandbox the test made. */
export const cleanSandboxes = (): void => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
};

export const DIGEST = `sha256:${"ab".repeat(32)}`;
const FAKE = `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(a) + "\\n");
if (a[0] === "info") console.log(process.env.FAKE_ROOTLESS ?? "true");
else if (a[0] === "image" && a[1] === "inspect") console.log(process.env.FAKE_DIGEST ?? "");
else if (a[0] === "container" && a[1] === "exists") process.exit(process.env.FAKE_NO_CONTAINER ? 1 : 0);
else if (a[0] === "logs") process.stdout.write(process.env.FAKE_LOGS ?? "");
`;

export interface Outcome {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[][];
}

/** A temp dir with a fake `podman` first on PATH that logs its argv; `exec` runs a script against it. */
export const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), "pap-container-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "podman"), FAKE);
  chmodSync(join(bin, "podman"), 0o755);
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  const exec = (script: string, args: string[], env: Record<string, string> = {}): Outcome => {
    const result = spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: root, FAKE_LOG: log, ...env },
    });
    const calls = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
  };
  return { root, exec };
};

import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { safePath } from "./unit.ts";

export const LAUNCHER_MARK = "# pap launcher (written by pap service install)";

/** Fixed text; the three inputs went through `safePath`, so single quotes cannot be closed from inside. */
export function renderLauncher(input: { node: string; main: string; home?: string }): string {
  const node = safePath("--node", input.node);
  const main = safePath("--main", input.main);
  return [
    "#!/bin/sh",
    LAUNCHER_MARK,
    ...(input.home === undefined ? [] : [`PAP_HOME='${safePath("--home", input.home)}'`, "export PAP_HOME"]),
    `exec '${node}' --disable-warning=ExperimentalWarning '${main}' "$@"`,
    "",
  ].join("\n");
}

const HEAD = `#!/bin/sh\n${LAUNCHER_MARK}\n`;

/** true: ours; false: anything else at the target (including unreadable); null: nothing there (ENOENT only). */
const ours = (target: string): boolean | null => {
  try {
    if (!lstatSync(target).isFile()) return false;
    const fd = openSync(target, "r");
    try {
      const buffer = Buffer.alloc(4096);
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, length).toString("utf8").startsWith(HEAD);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return (error as { code?: unknown }).code === "ENOENT" ? null : false;
  }
};

/** "foreign": a file or link that is not ours sits at the target; it is never replaced. */
export function writeLauncher(binDir: string, content: string): "written" | "foreign" {
  const dir = safePath("--bin-dir", binDir);
  const target = join(dir, "pap");
  if (ours(target) === false) return "foreign";
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, content, { flag: "wx", mode: 0o755 });
  chmodSync(temp, 0o755);
  renameSync(temp, target);
  return "written";
}

export function removeLauncher(binDir: string): void {
  const target = join(safePath("--bin-dir", binDir), "pap");
  if (ours(target) === true) rmSync(target);
}

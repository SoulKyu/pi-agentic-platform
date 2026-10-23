import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, expect } from "vitest";

export const TEMPLATE = join(import.meta.dirname, "archive-install.sh.tpl");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export const exe = (path: string, body: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};
export const readIfExists = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

export interface Root {
  root: string;
  home: string;
  bin: string;
  sysLog: string;
}
export const makeRoot = (): Root => {
  const root = mkdtempSync(join(tmpdir(), "pap-archive-test-"));
  dirs.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const sysLog = join(root, "systemctl.log");
  mkdirSync(home);
  exe(
    join(bin, "systemctl"),
    [
      'echo "$*" >> "$SYSLOG"',
      'if [ "$1 $2" = "--user show-environment" ] && [ -n "$NO_MANAGER" ]; then exit 1; fi',
      'if [ "$2" = reset-failed ] && [ -n "$RESET_FAILS" ]; then exit 1; fi',
      'if [ "$2" = restart ] && [ -n "$RESTART_FAILS" ]; then exit 1; fi',
      'if [ "$2" = cat ] && [ -n "$UNIT_TEXT" ]; then printf "%s\\n" "$UNIT_TEXT"; exit 0; fi',
      "exit 0",
    ].join("\n"),
  );
  // Shims that misbehave only when a test asks (env), otherwise they hand over to the real tool.
  exe(
    join(bin, "rm"),
    'case "$*" in *.stage.??????) [ -z "$FAIL_STAGE_RM" ] || exit 1 ;; esac\nexec /bin/rm "$@"',
  );
  exe(
    join(bin, "getconf"),
    [
      '[ -z "$GETCONF_EMPTY" ] || { echo "getconf: broken" >&2; exit 0; }',
      '[ -z "$GETCONF_FAILS" ] || { echo "getconf: broken" >&2; exit 1; }',
      '[ -z "$GETCONF_OUT" ] || { echo "$GETCONF_OUT"; exit 0; }',
      'exec /usr/bin/getconf "$@"',
    ].join("\n"),
  );
  exe(
    join(bin, "find"),
    '[ "$2 $3" != "-type l" ] || [ -z "$FAIL_FIND_LINKS" ] || exit 1\nexec /usr/bin/find "$@"',
  );
  // An extraction that dies after leaving a folder nobody may read (a stage rm -rf then fails on it).
  exe(
    join(bin, "tar"),
    [
      'case "$*" in *-xzf*) if [ -n "$EXTRACT_LEAVES_LOCKED" ]; then',
      '  while [ $# -gt 0 ]; do [ "$1" = -C ] && dest="$2"; shift; done',
      '  mkdir -p "$dest/locked" && : > "$dest/locked/f" && chmod 0100 "$dest/locked"; exit 1',
      "fi ;; esac",
      'exec /bin/tar "$@"',
    ].join("\n"),
  );
  return { root, home, bin, sysLog };
};

/** Minimal ustar writer: lets a test build members that `tar -c` would refuse to create. */
export interface Member {
  name: string;
  type?: "file" | "dir" | "sym" | "hard" | "fifo";
  data?: string;
  link?: string;
  exec?: boolean;
  /** Permission bits stored in the header (default 0755 for folders and executables, 0644 otherwise). */
  mode?: number;
  /** Owner and group name stored in the header (may hold spaces). */
  owner?: string;
}
const header = (member: Member): Buffer => {
  const block = Buffer.alloc(512);
  const data = Buffer.from(member.data ?? "");
  const flag = { file: "0", dir: "5", sym: "2", hard: "1", fifo: "6" }[member.type ?? "file"];
  const put = (value: string, offset: number) => block.write(value, offset, "latin1");
  const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;
  put(member.name, 0);
  put(octal(member.mode ?? (member.type === "dir" || member.exec ? 0o755 : 0o644), 8), 100);
  put(octal(0, 8), 108);
  put(octal(0, 8), 116);
  put(octal(member.type === "file" || member.type === undefined ? data.length : 0, 12), 124);
  put(octal(0, 12), 136);
  put("        ", 148);
  put(flag, 156);
  put(member.link ?? "", 157);
  put("ustar\0" + "00", 257);
  put(member.owner ?? "", 265);
  put(member.owner ?? "", 297);
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
};
export const tarGz = (members: Member[]): Buffer => {
  const parts: Buffer[] = [];
  for (const member of members) {
    parts.push(header(member));
    const data = Buffer.from(member.type === undefined || member.type === "file" ? (member.data ?? "") : "");
    if (data.length > 0) parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
};

export const FAKE_NODE = 'printf \'%s\\n\' "$*" >> "$HOME/calls"\nexit "${NODE_EXIT:-0}"';
export const goodMembers = (id: string, extra: Member[] = []): Member[] => [
  { name: `pap-${id}/`, type: "dir" },
  { name: `pap-${id}/node/`, type: "dir" },
  { name: `pap-${id}/node/bin/`, type: "dir" },
  { name: `pap-${id}/node/bin/node`, data: `#!/bin/sh\n${FAKE_NODE}\n`, exec: true },
  { name: `pap-${id}/app/`, type: "dir" },
  { name: `pap-${id}/app/apps/`, type: "dir" },
  { name: `pap-${id}/app/apps/daemon/`, type: "dir" },
  { name: `pap-${id}/app/apps/daemon/dist/`, type: "dir" },
  { name: `pap-${id}/app/apps/daemon/dist/main.js`, data: "// main\n" },
  ...extra,
];

export interface BedOptions {
  minGlibc?: string;
  members?: Member[];
  realTar?: boolean;
}
export const installBed = (id: string, root: Root = makeRoot(), options: BedOptions = {}) => {
  const dist = join(root.root, `dist-${id}`);
  mkdirSync(dist);
  const name = `pap-${id}-linux-x64.tar.gz`;
  const archive = join(dist, name);
  if (options.realTar === false || options.members) {
    writeFileSync(archive, tarGz(options.members ?? goodMembers(id)));
  } else {
    const tree = join(dist, "tree");
    exe(join(tree, `pap-${id}`, "node/bin/node"), FAKE_NODE);
    exe(join(tree, `pap-${id}`, "app/apps/daemon/dist/main.js"), "# main");
    const made = spawnSync("tar", ["-czf", archive, "-C", tree, `pap-${id}`], { timeout: 60_000 });
    expect(made.status).toBe(0);
  }
  const sha = createHash("sha256").update(readFileSync(archive)).digest("hex");
  const script = join(dist, `pap-install-${id}.sh`);
  const filled = readFileSync(TEMPLATE, "utf8")
    .replaceAll("@@SHA256@@", sha)
    .replaceAll("@@RELEASE_ID@@", id)
    .replaceAll("@@ARCHIVE_NAME@@", name)
    .replaceAll("@@MIN_GLIBC@@", options.minGlibc ?? "2.0");
  writeFileSync(script, filled);
  chmodSync(script, 0o755);
  const app = join(root.home, ".local/share/pap");
  const run = (extra: { args?: string[]; env?: Record<string, string | undefined>; home?: string } = {}) => {
    const env: Record<string, string | undefined> = {
      PATH: `${root.bin}:${process.env.PATH ?? ""}`,
      HOME: extra.home ?? root.home,
      LANG: "C.UTF-8",
      SYSLOG: root.sysLog,
      ...extra.env,
    };
    const defined = Object.entries(env).filter(([, value]) => value !== undefined);
    const result = spawnSync("bash", [script, ...(extra.args ?? [])], {
      env: Object.fromEntries(defined) as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  return { ...root, dist, archive, script, app, name, run, id };
};

export const current = (app: string) => readlinkSync(join(app, "current"));
export const releases = (app: string) => readdirSync(join(app, "releases")).sort();
export const hasCurrent = (app: string) => existsSync(app) && readdirSync(app).includes("current");

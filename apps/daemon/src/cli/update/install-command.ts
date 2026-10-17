import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { freeMb } from "../../kernel/disk.ts";
import { VERSION } from "../../kernel/version.ts";
import { CliError, type CliIo } from "../open-home.ts";
import { installRoot } from "../ops/paths.ts";
import type { Command } from "../run-cli.ts";
import { UsageError } from "../usage.ts";
import { checkForUpdate, resolveChannel, UpdateFeedError } from "./check.ts";
import type { Feed } from "./feed.ts";
import { fetchLimited, FetchRefused, type FetchLike } from "./fetch.ts";
import { RELEASE_ID, readCurrent } from "./releases.ts";

export const INSTALL_USAGE = "usage: pap update install [--channel stable|next] [--from <abs dir>] [--yes]";

export type InstallKind = "checkout" | "npm" | "container";

/** How this pap was installed, from where its entry file lives; only used to say the right command when it is not an archive install. */
export function installKind(entry: string | undefined, inContainer: boolean): InstallKind {
  if (inContainer) return "container";
  return entry?.includes("/node_modules/") === true ? "npm" : "checkout";
}

const KIND_HINT: Record<InstallKind, string> = {
  checkout: "this pap runs from a checkout: update it with: git pull && scripts/install.sh --bin-dir <dir>",
  npm: "this pap was installed with npm: update it with: npm install -g @soulkyu/pi-agentic-platform@latest",
  container:
    "this pap runs in a container: update the image with: podman pull <image> (or scripts/pap-container.sh build), then start it again",
};

/** The only variables the installer sees (M6bR20b): never `PAP_UNIT`, the shell's `PAP_HOME`, the SSH agent, `GIT_*` or `LD_*`. */
const CHILD_ENV = ["PATH", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "DBUS_SESSION_BUS_ADDRESS", "LANG"] as const;
const INSTALLER_TIMEOUT_MS = 30 * 60_000;
const INSTALLER_MAX_BYTES = 1_048_576;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MB = 1_048_576;

const PLAN = [
  'pap restarts: running agent turns are interrupted (running agent runs, pending agent and secret requests expire, "use once" values are dropped, subagent rows are marked interrupted)',
  "kept: your data in the pap home (sessions, database, secrets) and the previous release",
  "if the new release does not start, it is rolled back to the previous one; writes made after a migration that then fails are discarded",
].join("\n");

/** What touches the network, the machine or the build; tests replace these. */
export interface InstallSeams {
  fetch?: FetchLike;
  version: string;
  nodeVersion: string;
  kind(): InstallKind;
}

const DEFAULT_SEAMS: InstallSeams = {
  version: VERSION,
  nodeVersion: process.versions.node,
  kind: () => installKind(process.argv[1], existsSync("/run/.containerenv")),
};

const nodeAtLeast = (running: string, needed: string): boolean => {
  const [rMajor = 0, rMinor = 0] = running.split(".").map(Number);
  const [nMajor = 0, nMinor = 0] = needed.split(".").map(Number);
  return rMajor !== nMajor ? rMajor > nMajor : rMinor >= nMinor;
};

/** A folder for `--from`: exactly one `pap-install-<id>.sh` (a regular file) with its `pap-<id>-linux-x64.tar.gz` beside it. */
function readBuiltFolder(dir: string): { installer: string; id: string } {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw new CliError(`--from ${dir} cannot be read`);
  }
  const installers = names.filter((name) => /^pap-install-[A-Za-z0-9._-]{1,64}\.sh$/.test(name));
  if (installers.length !== 1)
    throw new CliError(`--from needs exactly one pap-install-<id>.sh in ${dir} (found ${installers.length})`);
  const installer = installers[0] as string;
  const id = installer.slice("pap-install-".length, -".sh".length);
  const archive = `pap-${id}-linux-x64.tar.gz`;
  for (const name of [installer, archive]) {
    let regular = false;
    try {
      regular = lstatSync(join(dir, name)).isFile();
    } catch {
      // absent
    }
    if (!regular) throw new CliError(`--from needs ${name} as a regular file in ${dir}`);
  }
  return { installer: join(dir, installer), id };
}

/** Runs `bash <installer>` in its folder with the allowlisted environment; resolves with the exit code, or null when it did not finish. */
function runInstaller(io: CliIo, installer: string, cwd: string): Promise<number | null> {
  const env: NodeJS.ProcessEnv = { HOME: io.homedir };
  for (const name of CHILD_ENV) {
    const value = io.env[name];
    if (value !== undefined) env[name] = value;
  }
  return new Promise((resolve) => {
    const child = spawn("bash", [installer], { cwd, env, stdio: "inherit", timeout: INSTALLER_TIMEOUT_MS });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
}

const sameHash = (hex: string, expected: string): boolean => {
  const [a, b] = [Buffer.from(hex, "hex"), Buffer.from(expected, "hex")];
  return a.length === b.length && timingSafeEqual(a, b);
};

async function download(feed: Feed, dir: string, seams: InstallSeams): Promise<string> {
  const get = async (asset: Feed["installer"] | Feed["archive"], maxBytes: number) => {
    let bytes: Uint8Array;
    try {
      bytes = await fetchLimited(asset.url, {
        maxBytes,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        userAgent: `pap/${seams.version}`,
        ...(seams.fetch === undefined ? {} : { fetch: seams.fetch }),
      });
    } catch (error) {
      if (error instanceof FetchRefused) throw new CliError(`cannot download ${asset.name} (${error.code})`);
      throw error;
    }
    if (bytes.length !== asset.size)
      throw new CliError(`${asset.name} is not the size the feed announces: refusing it`);
    return bytes;
  };
  if (feed.installer.size > INSTALLER_MAX_BYTES)
    throw new CliError("the installer the feed announces is above 1 MiB: refusing it");
  const installer = await get(feed.installer, feed.installer.size);
  if (!sameHash(createHash("sha256").update(installer).digest("hex"), feed.installer.sha256))
    throw new CliError(
      `${feed.installer.name} does not match the feed's SHA-256: refusing it, nothing was run`,
    );
  const path = join(dir, feed.installer.name);
  writeFileSync(path, installer, { mode: 0o700, flag: "wx" });
  const archive = await get(feed.archive, feed.archive.size);
  writeFileSync(join(dir, feed.archive.name), archive, { mode: 0o600, flag: "wx" });
  return path;
}

export function makeInstallCommand(overrides: Partial<InstallSeams> = {}): Command {
  const seams: InstallSeams = { ...DEFAULT_SEAMS, ...overrides };
  return {
    options: {
      channel: { type: "string" },
      from: { type: "string" },
      yes: { type: "boolean" },
      help: { type: "boolean" },
    },
    async run({ values, positionals, io }) {
      if (values.help === true) {
        io.stdout.write(`${INSTALL_USAGE}\n`);
        return 0;
      }
      if (positionals.length > 0) throw new UsageError("update install takes no argument");
      const yes = values.yes === true;
      const from = typeof values.from === "string" ? values.from : undefined;
      if (from !== undefined && !isAbsolute(from)) throw new UsageError("--from must be an absolute folder");
      const channel = resolveChannel(typeof values.channel === "string" ? values.channel : undefined, io.env);
      if (channel === null) throw new UsageError("the channel must be stable or next");
      const app = installRoot(io);
      const current = readCurrent(app);
      if (current === null) throw new CliError(KIND_HINT[seams.kind()]);

      if (from !== undefined) {
        const built = readBuiltFolder(from);
        io.stdout.write(`update from ${from}: ${current} -> ${built.id}\n${PLAN}\n`);
        if (!yes) {
          io.stdout.write("nothing was changed: run again with --yes to install\n");
          return 0;
        }
        return finish(io, await runInstaller(io, built.installer, from));
      }

      let feed: Feed;
      try {
        const answer = await checkForUpdate({
          channel,
          current: seams.version,
          ...(seams.fetch === undefined ? {} : { fetch: seams.fetch }),
        });
        if (answer.status !== "newer") throw new CliError(`pap is up to date (${seams.version}, ${channel})`);
        feed = answer.feed;
      } catch (error) {
        if (error instanceof UpdateFeedError)
          throw new CliError(`cannot read the update feed (${error.code})`);
        throw error;
      }
      if (!nodeAtLeast(seams.nodeVersion, feed.minNode))
        throw new CliError(
          `${feed.version} needs Node ${feed.minNode} or newer; this is Node ${seams.nodeVersion}`,
        );
      if (!RELEASE_ID.test(feed.releaseId))
        throw new CliError("the feed names a release id pap does not accept");
      io.stdout.write(
        `update: ${seams.version} -> ${feed.version} (${channel})\n${PLAN}\nthe installer is checked against the SHA-256 in the feed, which comes from github.com (a trusted host; the release is not signed)\n`,
      );
      if (!yes) {
        io.stdout.write("nothing was changed: run again with --yes to download and install\n");
        return 0;
      }
      const downloads = join(app, "downloads");
      mkdirSync(downloads, { recursive: true, mode: 0o700 });
      const needed = Math.ceil((feed.archive.size * 2) / MB) + 64;
      const free = freeMb(downloads);
      if (free !== null && free < needed)
        throw new CliError(`not enough disk space for the download: ${free} MB free, ${needed} MB needed`);
      const dir = mkdtempSync(join(downloads, "dl."));
      try {
        const installer = await download(feed, dir, seams);
        return finish(io, await runInstaller(io, installer, dir));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** The installer's own exit code is the command's (0, 3 unverified, 4 rolled back, 5 rollback incomplete). */
function finish(io: CliIo, code: number | null): number {
  if (code !== null) return code;
  io.stderr.write(
    "pap: the installer did not finish (killed, timed out or could not start): if it was interrupted, run: pap doctor\n",
  );
  return 1;
}

export const updateInstall: Command = makeInstallCommand();

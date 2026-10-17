import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  CHANNELS,
  FEED_REPO,
  FeedSchema,
  type Channel,
  type Feed,
} from "../apps/daemon/src/cli/update/feed.ts";

export interface FeedOptions {
  /** The folder `build:archive` wrote: one installer and one archive. */
  dir: string;
  channel: Channel;
  tag: string;
  repo: string;
  out: string;
  nodeMin?: string;
  /** `next` only: the core version and the CI run number that make `<core>-next.<run>`. */
  core?: string;
  runNumber?: number;
  now?: Date;
  force?: boolean;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/;
const CORE = /^\d+\.\d+\.\d+$/;
const INSTALLER = /^pap-install-(.+)\.sh$/;
const ARCHIVE = /^pap-.+-linux-x64\.tar\.gz$/;

const only = (names: string[], pattern: RegExp, what: string): string => {
  const found = names.filter((name) => pattern.test(name));
  if (found.length !== 1) throw new Error(`the folder must hold exactly one ${what}, found ${found.length}`);
  return found[0] as string;
};

const describeFile = (dir: string, name: string) => {
  const path = join(dir, name);
  if (!statSync(path).isFile()) throw new Error(`${name} is not a regular file`);
  return { path, size: statSync(path).size };
};

const versionOf = (options: FeedOptions): string => {
  if (options.channel === "stable") {
    const match = STABLE_TAG.exec(options.tag);
    if (!match?.[1]) throw new Error(`the stable tag must look like v1.2.3, got ${options.tag}`);
    return match[1];
  }
  if (options.tag !== "next") throw new Error(`the next tag must be "next", got ${options.tag}`);
  if (!options.core || !CORE.test(options.core)) throw new Error("the next channel needs --core x.y.z");
  if (!Number.isInteger(options.runNumber) || (options.runNumber ?? -1) < 0)
    throw new Error("the next channel needs a run number (a non-negative integer)");
  return `${options.core}-next.${options.runNumber}`;
};

/** Writes `pap-feed-<channel>.json` and `.env` into `out` after FeedSchema accepted the JSON; returns the feed. */
export function generateFeed(options: FeedOptions): Feed {
  if (!REPO.test(options.repo) || options.repo.includes(".."))
    throw new Error("--repo must look like owner/name, with no space and no ..");
  const version = versionOf(options);
  const names = readdirSync(options.dir);
  const installerName = only(names, INSTALLER, "installer (pap-install-<id>.sh)");
  const archiveName = only(names, ARCHIVE, "archive (pap-<id>-linux-x64.tar.gz)");
  const releaseId = INSTALLER.exec(installerName)?.[1] as string;
  const installer = describeFile(options.dir, installerName);
  const archive = describeFile(options.dir, archiveName);
  const base = `https://github.com/${options.repo}/releases`;
  const asset = (name: string) => `${base}/download/${options.tag}/${name}`;
  const sha256 = createHash("sha256").update(readFileSync(installer.path)).digest("hex");

  const feed = FeedSchema.parse({
    format: 1,
    channel: options.channel,
    version,
    releaseId,
    publishedAt: (options.now ?? new Date()).toISOString(),
    minNode: options.nodeMin ?? "24.14",
    notes: `${base}/tag/${options.tag}`,
    installer: { name: installerName, url: asset(installerName), size: installer.size, sha256 },
    archive: { name: archiveName, url: asset(archiveName), size: archive.size },
  });
  const env =
    [
      ["VERSION", feed.version],
      ["RELEASE_ID", feed.releaseId],
      ["INSTALLER_NAME", feed.installer.name],
      ["INSTALLER_URL", feed.installer.url],
      ["INSTALLER_SHA256", feed.installer.sha256],
      ["ARCHIVE_NAME", feed.archive.name],
      ["ARCHIVE_URL", feed.archive.url],
    ]
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n";

  const targets = [
    join(options.out, `pap-feed-${options.channel}.json`),
    join(options.out, `pap-feed-${options.channel}.env`),
  ];
  for (const target of targets)
    if (!options.force && existsSync(target)) throw new Error(`${target} exists: remove it or pass --force`);
  const flag = options.force ? "w" : "wx";
  writeFileSync(targets[0] as string, `${JSON.stringify(feed, null, 2)}\n`, { flag });
  writeFileSync(targets[1] as string, env, { flag });
  return feed;
}

const main = (): void => {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      channel: { type: "string" },
      tag: { type: "string" },
      repo: { type: "string", default: FEED_REPO },
      out: { type: "string" },
      "node-min": { type: "string" },
      core: { type: "string" },
      "run-number": { type: "string" },
      force: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const channel = CHANNELS.find((name) => name === values.channel);
  if (!values.dir || !values.tag || !values.out || !channel)
    throw new Error(
      "usage: release-feed.ts --dir D --channel stable|next --tag T --out D [--repo R] [--node-min 24.14]",
    );
  generateFeed({
    dir: resolve(values.dir),
    channel,
    tag: values.tag,
    repo: values.repo,
    out: resolve(values.out),
    nodeMin: values["node-min"],
    core: values.core,
    runNumber: values["run-number"] === undefined ? undefined : Number(values["run-number"]),
    force: values.force,
  });
  console.log(`pap-feed-${channel}.json and .env written to ${resolve(values.out)}`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error: unknown) {
    console.error(`release-feed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CHANNELS, FEED_REPO, type Channel } from "../apps/daemon/src/cli/update/feed.ts";
import { generateFeed } from "./release-feed.ts";

const quote = (text: string): string =>
  /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;

/** `--tag` defaults to v<root version> (stable) or `next`; a tag that does not fit the channel (a stable tag other than v<root version>) is refused. */
export const assetTag = (channel: Channel, tag: string | undefined, rootVersion: string): string => {
  const chosen = tag ?? (channel === "next" ? "next" : `v${rootVersion}`);
  const ok = channel === "next" ? chosen === "next" : chosen === `v${rootVersion}`;
  if (!ok) throw new Error(`the tag ${chosen} does not fit the ${channel} channel`);
  return chosen;
};

/** The `gh` commands the owner runs by hand; this script never runs them. */
export const printedCommands = (channel: Channel, tag: string, repo: string, dir: string): string[] => {
  const files = `${quote(dir)}/*`;
  const create =
    channel === "next"
      ? `gh release create next --repo ${repo} --prerelease --title next --notes 'Rolling pre-release of main' ${files}`
      : `gh release create ${tag} --repo ${repo} --title ${tag} --generate-notes ${files}`;
  return [create, `gh release upload ${tag} --repo ${repo} --clobber ${files}`];
};

const main = (): void => {
  const { values } = parseArgs({
    options: {
      channel: { type: "string", default: "stable" },
      tag: { type: "string" },
      "run-number": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const channel = CHANNELS.find((name) => name === values.channel);
  if (!channel) throw new Error("--channel must be stable or next");
  const repo = resolve(import.meta.dirname, "..");
  const rootVersion = (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string })
    .version;
  const tag = assetTag(channel, values.tag, rootVersion);
  const dir = join(repo, ".pap-release", tag);
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${dir} is not empty: remove it first`);
  mkdirSync(dir, { recursive: true });
  execFileSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(repo, "scripts/build-archive.ts"), "--out", dir],
    { cwd: repo, stdio: "inherit", timeout: 900_000 },
  );
  generateFeed({
    dir,
    channel,
    tag,
    repo: FEED_REPO,
    out: dir,
    core: rootVersion,
    runNumber:
      values["run-number"] === undefined
        ? channel === "next"
          ? 0
          : undefined
        : Number(values["run-number"]),
  });
  console.log(`\nrelease assets for ${tag} are in ${dir}. Nothing was uploaded. Run by hand:`);
  for (const command of printedCommands(channel, tag, FEED_REPO, dir)) console.log(`  ${command}`);
  console.log("(use the create command for a first release, the upload command to replace assets)");
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error: unknown) {
    console.error(`release-assets: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

export type Runner = (cmd: string, args: readonly string[], cwd: string) => Promise<void>;

/** The dist folders the daemon needs; the layout stays `app/apps/{daemon,web}/dist` (the daemon resolves ../../web/dist). */
export const DIST_DIRS = ["apps/daemon", "apps/web", "packages/contracts", "packages/pi-host"] as const;

const WORKSPACE_PARENTS = ["apps", "packages"] as const;
const STATE_FILES = [".modules.yaml", ".pnpm-workspace-state-v1.json"] as const;
const CREDENTIAL = /_authToken|_password|_auth\s*=|^\s*\/\/[^\s/]+\/[^\s]*:|\bnpm_[A-Za-z0-9]{20,}/m;

export const missingDist = (repo: string): string[] =>
  DIST_DIRS.map((dir) => `${dir}/dist`).filter((dir) => !existsSync(join(repo, dir)));

/** Only `engine-strict` survives: the builder's own .npmrc may hold a registry token (M6R39). */
export const allowlistNpmrc = (text: string): string => {
  const match = /^engine-strict\s*=\s*(true|false)\s*$/m.exec(text);
  return match ? `engine-strict=${match[1]}\n` : "";
};

const workspaceManifests = (repo: string): string[] =>
  WORKSPACE_PARENTS.flatMap((parent) =>
    existsSync(join(repo, parent))
      ? readdirSync(join(repo, parent), { withFileTypes: true })
          .filter(
            (entry) => entry.isDirectory() && existsSync(join(repo, parent, entry.name, "package.json")),
          )
          .map((entry) => `${parent}/${entry.name}/package.json`)
          .sort()
      : [],
  );

/** Refuses when a staged manifest could carry a registry credential. Names the file, never the value. */
export const assertNoCredentials = (app: string): void => {
  const files = [".npmrc", "pnpm-workspace.yaml", "package.json", ...workspaceManifests(app)];
  for (const file of files) {
    if (existsSync(join(app, file)) && CREDENTIAL.test(readFileSync(join(app, file), "utf8"))) {
      throw new Error(`${file} looks like it holds a registry credential: nothing was packed`);
    }
  }
};

export interface StageOptions {
  repo: string;
  app: string;
  run: Runner;
  storeDir?: string;
}

const entriesUnder = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true });

/** pnpm's `.bin` shims carry absolute NODE_PATH lines naming the install directory and are unused at runtime (W5-R10). */
export const removeBinShims = (app: string): void => {
  const shims = entriesUnder(app)
    .filter((entry) => entry.isDirectory() && entry.name === ".bin")
    .map((entry) => join(entry.parentPath, entry.name));
  for (const dir of shims) rmSync(dir, { recursive: true, force: true });
};

/** node-gyp leaves Makefile, config.gypi and *.mk next to pty.node with the builder's home in them; only Release/pty.node is loaded. */
export const pruneNodePtyBuild = (app: string): void => {
  const leftovers = entriesUnder(app)
    .filter((entry) => entry.isFile() && /[\\/]node-pty[\\/]build$/.test(entry.parentPath))
    .map((entry) => join(entry.parentPath, entry.name));
  for (const file of leftovers) rmSync(file, { force: true });
};

/** Fails closed, naming only the file, when a staged file or a link target still names the throwaway stage directory or the builder's home. */
export const assertNoStagePath = (root: string, stage: string, home = homedir()): void => {
  const needles = [stage, home].filter((text) => text.length > 1).map((text) => Buffer.from(text));
  for (const entry of entriesUnder(root)) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const file = join(entry.parentPath, entry.name);
    const text = entry.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file);
    if (needles.some((needle) => text.includes(needle))) {
      throw new Error(
        `${relative(root, file)} names the build directory or the builder home: nothing was packed`,
      );
    }
  }
};

const assertNoSymlinks = (dist: string): void => {
  const link = entriesUnder(dist).find((entry) => entry.isSymbolicLink());
  if (link) throw new Error(`${relative(dist, join(link.parentPath, link.name))} in ${dist} is a symlink`);
};

const storeIsUsable = (storeDir: string): boolean => existsSync(storeDir) && readdirSync(storeDir).length > 0;

/** Copies the allowlist into `app`, installs the production dependencies offline, strips builder state. */
export const stageTree = async ({ repo, app, run, storeDir }: StageOptions): Promise<void> => {
  const storeMessage = `the pnpm store at ${storeDir} lacks the packages: run pnpm install first`;
  if (storeDir && !storeIsUsable(storeDir)) throw new Error(storeMessage);
  mkdirSync(app, { recursive: true });
  const copies = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", ...workspaceManifests(repo)];
  for (const file of copies) {
    mkdirSync(join(app, file, ".."), { recursive: true });
    cpSync(join(repo, file), join(app, file));
  }
  for (const dir of DIST_DIRS) {
    assertNoSymlinks(join(repo, dir, "dist"));
    cpSync(join(repo, dir, "dist"), join(app, dir, "dist"), { recursive: true });
  }
  const npmrc = existsSync(join(repo, ".npmrc"))
    ? allowlistNpmrc(readFileSync(join(repo, ".npmrc"), "utf8"))
    : "";
  if (npmrc) writeFileSync(join(app, ".npmrc"), npmrc);
  assertNoCredentials(app);
  try {
    await run(
      "pnpm",
      [
        "install",
        "--prod",
        "--frozen-lockfile",
        "--offline",
        "--package-import-method=copy",
        ...(storeDir ? ["--store-dir", storeDir] : []),
        "--filter",
        "@pap/daemon...",
      ],
      app,
    );
  } catch {
    throw new Error(storeDir ? storeMessage : "pnpm install failed: run pnpm install first");
  }
  for (const file of STATE_FILES) rmSync(join(app, "node_modules", file), { force: true });
  removeBinShims(app);
  pruneNodePtyBuild(app);
};

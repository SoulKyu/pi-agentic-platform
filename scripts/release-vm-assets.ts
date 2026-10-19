import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseAssets } from "../apps/daemon/src/cli/vm/assets.ts";
import { assertAgentBundle, AGENT_BUNDLE, deployProd, finishAgentBundle } from "./build-agent-bundle.ts";
import type { Runner } from "./build-archive-stage.ts";

export const VMD_PACKAGE = "apps/vmd";
const VMD_BUILDING = "apps/vmd/.release-building";
/** What pap-vmd starts from: its entry and the built contracts it imports. */
export const VMD_REQUIRED = [
  "dist/main.js",
  "package.json",
  "node_modules/@pap/contracts/dist/index.js",
] as const;
const TEMPLATE = "apps/daemon/src/cli/vm/vm-assets.json";

export interface VmArtefactOptions {
  repo: string;
  run: Runner;
  storeDir: string;
  /** Release folder: the tarballs and `vm-assets.json` are written here. */
  dir: string;
  /** Release tag and the version in the file names. */
  tag: string;
  version: string;
  /** `owner/name` of the repository the release is published on. */
  feedRepo: string;
  sha256: (path: string) => Promise<string>;
}

/** The same reproducible tar flags as the pap archive: sorted, owner 0, fixed mtime, no group or other write. */
export const packFolder = (run: Runner, folder: string, archive: string): Promise<void> =>
  run(
    "tar",
    [
      "--mode=u+rwX,go+rX,go-w",
      "--sort=name",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--mtime=@0",
      "-czf",
      archive,
      "-C",
      folder,
      ".",
    ],
    folder,
  );

/** pap-vmd's production deploy (contracts' dist included), same offline deploy and pruning as the agent bundle (T14b). */
export const buildVmdBundle = async (o: VmArtefactOptions, archive: string): Promise<void> => {
  if (!existsSync(join(o.repo, VMD_PACKAGE, "package.json")))
    throw new Error(`${VMD_PACKAGE} does not exist`);
  const building = join(o.repo, VMD_BUILDING);
  rmSync(building, { recursive: true, force: true });
  try {
    await deployProd({ repo: o.repo, run: o.run, storeDir: o.storeDir, filter: "@pap/vmd", dest: building });
    finishAgentBundle(building);
    assertAgentBundle(building, [homedir(), o.repo, o.storeDir], VMD_REQUIRED);
    await packFolder(o.run, building, archive);
  } finally {
    rmSync(building, { recursive: true, force: true });
  }
};

/** dist-agent (AVM-E31), checked again before it is packed. */
export const buildAgentBundleArchive = async (o: VmArtefactOptions, archive: string): Promise<void> => {
  const bundle = join(o.repo, AGENT_BUNDLE);
  assertAgentBundle(bundle, [homedir(), o.repo, o.storeDir]);
  await packFolder(o.run, bundle, archive);
};

/** Both tarballs and the release's `vm-assets.json`: the repository's pins plus the two hashes of this build. */
export const buildVmArtefacts = async (o: VmArtefactOptions): Promise<void> => {
  const vmd = join(o.dir, `pap-vmd-${o.version}.tar.gz`);
  const bundle = join(o.dir, `pap-agent-bundle-${o.version}.tar.gz`);
  await buildVmdBundle(o, vmd);
  await buildAgentBundleArchive(o, bundle);
  const template = JSON.parse(readFileSync(join(o.repo, TEMPLATE), "utf8")) as {
    assets: Array<{ name: string; version: string; url: string; sha256: string }>;
  };
  const filled = {
    ...template,
    assets: template.assets.map((asset) => {
      const file = asset.name === "pap-vmd" ? vmd : asset.name === "pap-agent-bundle" ? bundle : undefined;
      return file === undefined
        ? asset
        : {
            ...asset,
            version: o.version,
            url: `https://github.com/${o.feedRepo}/releases/download/${o.tag}/${file.split("/").pop()}`,
          };
    }),
  };
  for (const asset of filled.assets) {
    if (asset.name === "pap-vmd") asset.sha256 = await o.sha256(vmd);
    if (asset.name === "pap-agent-bundle") asset.sha256 = await o.sha256(bundle);
  }
  parseAssets(filled);
  const out = join(o.dir, "vm-assets.json");
  writeFileSync(`${out}.tmp`, `${JSON.stringify(filled, null, 2)}\n`);
  renameSync(`${out}.tmp`, out);
};

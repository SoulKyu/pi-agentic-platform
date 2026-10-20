import { cpSync, existsSync, mkdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { within } from "../../kernel/fs/boundary.ts";
import { treeDigest } from "./image-inputs.ts";
import { walkTree } from "./secret-scan.ts";

const FORMAT = "pap-base-1";
/** The Node image digest as `vm-assets.json` pins it, bare or as the full `docker.io/library/node@sha256:...` reference. */
const NODE_DIGEST = /^(?:docker\.io\/library\/node@)?(sha256:[0-9a-f]{64})$/;
/**
 * T13a's context layout. pap-vmd no longer builds from it (AVM-E31): its base context is the root-owned bundle folder itself and
 * the Dockerfile COPYs `.` to `/opt/pap/pi-host/` (J1b), so only the tree digest below is still meaningful.
 */
const BUNDLE_AT = "pap/pi-host";
const REQUIRED = ["dist/guest/main.js", "dist/relay/main.js", "package.json"] as const;

/** Every required file is there and every link is relative, resolves, and stays inside the bundle (T13a copies links as links). */
function checkBundle(bundle: string): void {
  for (const file of REQUIRED)
    if (!existsSync(join(bundle, file))) throw new Error(`the agent bundle lacks ${file}`);
  const root = realpathSync(bundle);
  for (const entry of walkTree(bundle)) {
    if (entry.kind === "other") throw new Error(`${entry.rel} is a special file`);
    if (entry.kind !== "link") continue;
    if (isAbsolute(readlinkSync(join(bundle, entry.rel))))
      throw new Error(`${entry.rel} is an absolute link`);
    let real: string;
    try {
      real = realpathSync(join(bundle, entry.rel));
    } catch {
      throw new Error(`${entry.rel} is a link that does not resolve`);
    }
    if (!within(root, real)) throw new Error(`${entry.rel} is a link that leaves the bundle`);
  }
}

/**
 * The base layer's build context: the agent bundle at `<out>/pap/pi-host` (`out` is replaced). The tag is the sha256 of
 * the bundle's tree and the Node digest, nothing else (not the path, the times or the week): same inputs, same tag.
 */
export function prepareBaseContext(bundle: string, out: string, nodeDigest: string): { tag: string } {
  const digest = NODE_DIGEST.exec(nodeDigest)?.[1];
  if (digest === undefined) throw new Error("the node digest is not a sha256 digest");
  if (!isAbsolute(bundle) || !isAbsolute(out) || within(bundle, out) || within(out, bundle))
    throw new Error("base output folder is not usable");
  checkBundle(bundle);
  rmSync(out, { recursive: true, force: true });
  try {
    mkdirSync(join(out, "pap"), { recursive: true });
    cpSync(bundle, join(out, BUNDLE_AT), { recursive: true, verbatimSymlinks: true });
    return { tag: `pap-agent-base-${treeDigest(join(out, BUNDLE_AT), `${FORMAT}\0${digest}`)}` };
  } catch (error) {
    rmSync(out, { recursive: true, force: true });
    throw error;
  }
}

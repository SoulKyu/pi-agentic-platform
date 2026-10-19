import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { IMAGE_TAG } from "@pap/contracts";
import { buildArgv, imageRef, imagesArgv, psImagesArgv, rmiArgv } from "./argv.ts";
import { renderDockerfile } from "./dockerfile.ts";
import { VmdFailure } from "./errors.ts";
import type { ImageBuildRequest, OpsDeps } from "./ops.ts";
import { copyTreeSafely, type SafeTreeLimits } from "./safe-tree.ts";

const BUILD_TIMEOUT_MS = 30 * 60_000;
/** A build context needs room for its copy and BuildKit's layers. */
const BUILD_NEED_MB = 2048;
const CONTEXT_LIMITS: SafeTreeLimits = { maxBytes: 1024 * 1024 * 1024, maxEntries: 200_000 };
const PAP_IMAGE = /^pap\.local\/(.+):1$/;

type Prune = { keep: string[] };

export function createImageOps(deps: OpsDeps) {
  const { exec, state, locks, room, log } = deps;

  /** The repository:tag lines of `nerdctl images` that are pap's own image tags. */
  async function papTags(): Promise<string[]> {
    const result = await exec(imagesArgv());
    if (result.code !== 0) throw new VmdFailure("failed");
    const tags = result.stdout.split("\n").flatMap((line) => {
      const tag = PAP_IMAGE.exec(line.trim())?.[1];
      return tag !== undefined && IMAGE_TAG.test(tag) ? [tag] : [];
    });
    return tags.sort();
  }

  /** AVM-E31, R19: the base layer is built from the root-owned bundle; the other layers from pap's user's tree, copied first. */
  function copyContext(request: ImageBuildRequest, target: string): void {
    const fromBundle = request.layer === "base";
    const source = fromBundle ? deps.bundleRoot : path.join(deps.papHome, "vm", "build", request.layer);
    const uid = fromBundle ? deps.bundleUid : deps.papUid;
    const refused = copyTreeSafely(source, target, uid, CONTEXT_LIMITS);
    if (refused === "missing" && request.layer === "agent") {
      // The agent layer only runs apt: its context may be empty.
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { mode: 0o755 });
      return;
    }
    if (refused === "missing") throw new VmdFailure("not_found");
    if (refused !== null) {
      log.info("vmd_build_refused", { layer: request.layer, reason: refused });
      throw new VmdFailure("bad_request");
    }
  }

  async function runBuild(request: ImageBuildRequest): Promise<unknown> {
    await room(BUILD_NEED_MB);
    const context = state.buildDir(request.layer);
    const dockerfileDir = state.dockerfileDir(request.layer);
    try {
      copyContext(request, context);
      // RT-33: the Dockerfile is rendered here, in a folder of its own, never inside the context.
      mkdirSync(dockerfileDir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(dockerfileDir, "Dockerfile"), renderDockerfile(request), { mode: 0o600 });
      const result = await exec(buildArgv(request, context, dockerfileDir), { timeoutMs: BUILD_TIMEOUT_MS });
      if (result.code !== 0) throw new VmdFailure("failed");
      return { tag: request.tag };
    } finally {
      rmSync(context, { recursive: true, force: true });
    }
  }

  const build = (request: ImageBuildRequest): Promise<unknown> =>
    locks.joinBuild(request.tag, () => runBuild(request));

  async function list(): Promise<unknown> {
    return { tags: await papTags() };
  }

  /** Removes every pap image that is not in `keep` and that no container (running or not) uses. */
  async function prune(request: Prune): Promise<unknown> {
    const tags = await papTags();
    const used = await exec(psImagesArgv());
    if (used.code !== 0) throw new VmdFailure("failed");
    const inUse = new Set(used.stdout.split("\n").map((line) => line.trim()));
    const keep = new Set(request.keep);
    const removed: string[] = [];
    for (const tag of tags) {
      if (keep.has(tag) || inUse.has(imageRef(tag))) continue;
      const result = await exec(rmiArgv(imageRef(tag)));
      if (result.code === 0) removed.push(tag);
      else log.info("vmd_prune_failed", { code: result.code });
    }
    return { removed };
  }

  async function health(): Promise<unknown> {
    const ruleset = (await exec(["/usr/sbin/nft", "list", "table", "bridge", "pap_agents"])).code === 0;
    const link = await exec(["/usr/sbin/ip", "-o", "link", "show", "pap0"]);
    const flags = /<([^>]*)>/.exec(link.stdout)?.[1]?.split(",") ?? [];
    let stateFreeMb = 0;
    try {
      stateFreeMb = await state.freeMb();
    } catch {
      log.info("vmd_health_statfs_failed", {});
    }
    return { version: deps.version, ruleset, bridge: link.code === 0 && flags.includes("UP"), stateFreeMb };
  }

  return { build, list, prune, health };
}

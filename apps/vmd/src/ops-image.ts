import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { IMAGE_TAG } from "@pap/contracts";
import { buildArgv, imageRef, imagesArgv, psImagesArgv, rmiArgv } from "./argv.ts";
import { renderDockerfile } from "./dockerfile.ts";
import { VmdFailure } from "./errors.ts";
import type { ImageBuildRequest, OpsDeps } from "./ops.ts";
import { copyTreeSafely, type SafeTreeLimits } from "./safe-tree.ts";
import { readNetFacts } from "./net-facts.ts";

const BUILD_TIMEOUT_MS = 30 * 60_000;
/** A build context needs room for its copy and BuildKit's layers. */
const BUILD_NEED_MB = 2048;
const CONTEXT_LIMITS: SafeTreeLimits = { maxBytes: 1024 * 1024 * 1024, maxEntries: 200_000 };
const PAP_IMAGE = /^pap\.local\/(.+):1$/;

type Prune = { keep: string[] };

/** Lines kept per tag, the width of one, and the bytes of a tail answer (one frame is 64 KiB). */
const TAIL_LINES = 200;
const LINE_CHARS = 512;
const TAIL_ANSWER_BYTES = 48 * 1024;

interface Tail {
  lines: string[];
  last: { line: string; at: number } | null;
}

export function createImageOps(deps: OpsDeps) {
  const { exec, state, locks, room, log } = deps;
  /** What BuildKit printed for each tag building now; a tag leaves when its build ends. */
  const tails = new Map<string, Tail>();

  function progress(request: { tag: string; tail?: true }): unknown {
    const tail = tails.get(request.tag);
    if (tail === undefined) return { building: false, lines: 0, last: null };
    const answer = { building: true, lines: tail.lines.length, last: tail.last };
    if (request.tail !== true) return answer;
    const kept: string[] = [];
    let bytes = 0;
    for (const line of [...tail.lines].reverse()) {
      bytes += Buffer.byteLength(JSON.stringify(line)) + 1;
      if (bytes > TAIL_ANSWER_BYTES) break;
      kept.unshift(line);
    }
    return { ...answer, tail: kept };
  }

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
    // I2: folders are keyed by tag, so two builds of one layer never share or delete each other's.
    const context = path.join(state.buildDir(request.layer), request.tag);
    const dockerfileDir = path.join(state.dockerfileDir(request.layer), request.tag);
    const tail: Tail = { lines: [], last: null };
    tails.set(request.tag, tail);
    try {
      mkdirSync(path.dirname(context), { recursive: true, mode: 0o700 });
      copyContext(request, context);
      // RT-33: the Dockerfile is rendered here, in a folder of its own, never inside the context.
      mkdirSync(dockerfileDir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(dockerfileDir, "Dockerfile"), renderDockerfile(request), { mode: 0o600 });
      const result = await exec(buildArgv(request, context, dockerfileDir), {
        timeoutMs: BUILD_TIMEOUT_MS,
        onLine(line) {
          const clipped = line.slice(0, LINE_CHARS);
          tail.lines.push(clipped);
          if (tail.lines.length > TAIL_LINES) tail.lines.shift();
          tail.last = { line: clipped, at: deps.clock.now() };
        },
      });
      if (result.code !== 0) throw new VmdFailure("failed");
      return { tag: request.tag };
    } finally {
      tails.delete(request.tag);
      rmSync(context, { recursive: true, force: true });
      rmSync(dockerfileDir, { recursive: true, force: true });
    }
  }

  const build = (request: ImageBuildRequest): Promise<unknown> =>
    locks.joinBuild(request.tag, () => runBuild(request));

  async function list(): Promise<unknown> {
    return { tags: await papTags() };
  }

  /** Caller contract: an image just built and not yet started must be in `keep`. Removes every pap image that is not in `keep` and that no container (running or not) uses. */
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
    const facts = await readNetFacts(exec);
    let stateFreeMb = 0;
    try {
      stateFreeMb = await state.freeMb();
    } catch {
      log.info("vmd_health_statfs_failed", {});
    }
    return { version: deps.version, ruleset: facts.ruleset, bridge: facts.bridge, stateFreeMb };
  }

  return { build, progress, list, prune, health };
}

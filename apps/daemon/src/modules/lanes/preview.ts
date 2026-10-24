import type { FileHandle } from "node:fs/promises";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  type Caller,
  type ForgeKind,
  LANE_LIMITS,
  type LanePreview,
  Oid,
  PapError,
  type ParamsOf,
  type ResultOf,
  type ScriptKind,
} from "@pap/contracts";
import { boxOfPath } from "../../kernel/box-path.ts";
import type { ProjectBoxSource } from "../../kernel/boxes.ts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { type BoundaryConfig, judgePath, type Scope } from "../../kernel/fs/boundary.ts";
import type { DenySet } from "../../kernel/fs/deny-set.ts";
import { openRegularFile } from "../../kernel/fs/safe-open.ts";
import { GitError, type GitRunner } from "../../kernel/git/runner.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import { requireStepUp } from "../auth/index.ts";
import { createApprovalsStore } from "./approvals-store.ts";
import { createConfigCache } from "./config-cache.ts";
import { NO_REMOTE, readRemoteInfo } from "./remote-facts.ts";
import {
  type ConfigRead,
  PROJECT_CONFIG_LIMITS,
  PROJECT_CONFIG_PATH,
  readProjectConfig,
  scriptHash,
} from "./project-config.ts";

export interface LaneConfigDeps {
  readonly db: Db;
  readonly git: GitRunner;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly boundary: BoundaryConfig;
  readonly deny: DenySet;
  /** The caller's project roots, as stored. */
  roots(ownerId: string): readonly string[];
  readonly audit: Pick<AuditPort, "append">;
  readonly readOnly: boolean;
  /** `Config.testGitProtocols` includes `file`: the push test seam (default false). */
  readonly allowFile?: boolean;
  /** Late-bound (J1 wires it): a box project's folder is not a lane project and never reaches the host. */
  readonly boxes?: () => ProjectBoxSource | undefined;
}

export interface LaneConfig {
  preview(caller: Caller, projectRoot: string): Promise<LanePreview>;
  approveScripts(
    caller: Caller,
    params: ParamsOf<"lanes.approveScripts">,
  ): Promise<ResultOf<"lanes.approveScripts">>;
  /**
   * The script runner's check (Task 5), made right before every spawn: the text of `kind` in the project's file as it
   * is now (never the cache), when it is exactly what the owner approved. Anything else is a reason, never a text.
   */
  approvedScript(
    ownerId: string,
    projectRoot: string,
    kind: ScriptKind,
  ): Promise<{ ok: true; text: string } | { ok: false; reason: "none" | "unapproved" }>;
  /** The `forge:` line of the project's `.pi/project.yaml` (cached read), or undefined (M9R70). */
  forgeLine(ownerId: string, projectRoot: string): Promise<ForgeKind | undefined>;
}

type BaseRefView = LanePreview["refs"][number];
type ProjectConfigView = LanePreview["config"];
type ScriptView = ProjectConfigView["scripts"][number];

const KINDS: readonly ScriptKind[] = ["setup", "archive", "test"];
const DEFAULT_PREFIX = "pi/";
const CHANGED = { ok: false, reason: "changed" } as const;
const REFS_FORMAT = "--format=%(refname)%00%(objectname)%00%(committerdate:unix)";
const REMOTE_HEAD = /^refs\/remotes\/.+\/HEAD$/;
/** An audit row's detail is at most 4 096 characters of JSON: a very long path is cut. */
const AUDIT_PATH_CHARS = 2000;

/** What reading `.pi/project.yaml` found: nothing, a file pap may not read, or its content. */
type FileState = { found: false } | { found: true; read: ConfigRead | "unreadable" };

const NO_FILE: FileState = { found: false };

async function readUpTo(handle: FileHandle, max: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(max);
  let filled = 0;
  while (filled < max) {
    const { bytesRead } = await handle.read(buffer, filled, max - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

const forgeLineOf = (state: FileState): ForgeKind | undefined =>
  state.found && state.read !== "unreadable" && state.read.ok ? state.read.config.forge : undefined;

const pairOf = (line: string, merged: ReadonlySet<string>): BaseRefView | null => {
  const [ref = "", oid = "", unix = ""] = line.split("\0");
  const at = unix === "" ? null : Number(unix) * 1000;
  const parsed = Oid.safeParse(oid);
  if (!parsed.success || ref.length > 255 || REMOTE_HEAD.test(ref)) return null;
  const label = ref.replace(/^refs\/(?:heads|remotes)\//, "");
  return {
    ref,
    label,
    oid: parsed.data,
    at: at !== null && Number.isSafeInteger(at) && at >= 0 ? at : null,
    inLineage: merged.has(ref),
  };
};

export function createLaneConfig(deps: LaneConfigDeps): LaneConfig {
  const { git } = deps;
  const approvals = createApprovalsStore(deps.db, deps.clock);
  const cache = createConfigCache();

  /** The project root is one of the caller's, exactly as stored (M9R26); another owner's or a subfolder is `not_found`. */
  const inBox = (ownerId: string, projectRoot: string): boolean =>
    boxOfPath(deps.boxes?.(), ownerId, projectRoot) !== null;

  function ownRoot(caller: Caller, projectRoot: string): void {
    if (!deps.roots(caller.userId).includes(projectRoot)) throw new PapError("not_found");
  }

  /**
   * `.pi/project.yaml` of the main checkout through the M8 boundary (M9R22): a link out of the repository, a FIFO or a
   * private file is `unreadable`. `fresh` skips the cache (an approval always judges the file as it is now).
   */
  async function loadFile(caller: Pick<Caller, "kind">, real: string, fresh: boolean): Promise<FileState> {
    const scope: Scope = { roots: [real], config: deps.boundary, caller: caller.kind };
    const judged = await judgePath(join(real, PROJECT_CONFIG_PATH), scope, "read");
    if (!judged.ok) return judged.why === "missing" ? NO_FILE : { found: true, read: "unreadable" };
    let handle: FileHandle | undefined;
    try {
      handle = await openRegularFile(judged.real, { ...scope, root: judged.root, deny: deps.deny });
      const info = await handle.stat();
      const load = async (): Promise<ConfigRead> =>
        info.size > PROJECT_CONFIG_LIMITS.fileBytes
          ? { ok: false, error: "too_large" }
          : readProjectConfig(await readUpTo(handle as FileHandle, PROJECT_CONFIG_LIMITS.fileBytes + 1));
      const key = { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
      return { found: true, read: fresh ? await load() : await cache.get(real, key, load) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return NO_FILE;
      deps.logger.debug("lanes_config_unreadable", {
        code: (error as NodeJS.ErrnoException).code ?? "boundary",
      });
      return { found: true, read: "unreadable" };
    } finally {
      await handle?.close().catch((error: unknown) => {
        deps.logger.debug("lanes_config_close_failed", { code: (error as NodeJS.ErrnoException).code });
      });
    }
  }

  function viewOf(ownerId: string, projectRoot: string, state: FileState): ProjectConfigView {
    const none = {
      branchPrefix: DEFAULT_PREFIX,
      waitForSetup: true,
      copy: [],
      link: [],
      scripts: [],
      warnings: [],
    };
    if (!state.found) return { found: false, error: null, ...none };
    if (state.read === "unreadable") return { found: true, error: "unreadable", ...none };
    if (!state.read.ok) return { found: true, error: state.read.error, ...none };
    const { config, warnings } = state.read;
    const scripts: ScriptView[] = [];
    for (const kind of KINDS) {
      const text = config[kind];
      if (text === undefined) continue;
      const sha256 = scriptHash(text);
      const stored = approvals.get(ownerId, projectRoot, kind);
      scripts.push({
        kind,
        text,
        sha256,
        approved: stored?.sha256 === sha256,
        previous: stored !== undefined && stored.sha256 !== sha256 ? stored.script : null,
      });
    }
    return {
      found: true,
      error: null,
      warnings: [...warnings],
      branchPrefix: config.branchPrefix ?? DEFAULT_PREFIX,
      waitForSetup: config.waitForSetup ?? true,
      copy: config.copy ?? [],
      link: config.link ?? [],
      scripts,
    };
  }

  /** The top level of a repository's main checkout: git agrees, and `.git` is a folder (a linked worktree has a file). */
  async function isMainCheckout(real: string): Promise<boolean> {
    try {
      const top = (await git.run(real, ["rev-parse", "--show-toplevel"])).stdout
        .toString("utf8")
        .replace(/\n$/, "");
      if (top !== real) return false;
    } catch (error) {
      if (error instanceof GitError && error.kind === "timeout") throw new PapError("timeout");
      if (error instanceof PapError) throw error;
      deps.logger.debug("lanes_preview_not_a_checkout", { kind: (error as { kind?: unknown }).kind });
      return false;
    }
    return (await lstat(join(real, ".git")).catch(() => null))?.isDirectory() === true;
  }

  async function currentBranch(real: string): Promise<string | null> {
    try {
      const name = (await git.run(real, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout
        .toString("utf8")
        .trim();
      return name === "" || name === "HEAD" ? null : name;
    } catch {
      return null;
    }
  }

  async function refsOf(real: string): Promise<BaseRefView[]> {
    try {
      const list = (...extra: string[]) =>
        git.run(real, [
          "for-each-ref",
          ...extra,
          "--sort=-committerdate",
          `--count=${LANE_LIMITS.baseRefs}`,
          "refs/heads",
          "refs/remotes",
        ]);
      // Lineage is git's own answer in one call (the refs HEAD contains), the same notion as the trust inheritance.
      const [all, contained] = await Promise.all([
        list(REFS_FORMAT),
        list("--format=%(refname)", "--merged=HEAD"),
      ]);
      const merged = new Set(contained.stdout.toString("utf8").split("\n"));
      return all.stdout
        .toString("utf8")
        .split("\n")
        .flatMap((line) => (line === "" ? [] : [pairOf(line, merged)]))
        .filter((ref): ref is BaseRefView => ref !== null);
    } catch (error) {
      if (error instanceof GitError && error.kind === "timeout") throw new PapError("timeout");
      if (error instanceof PapError) throw error;
      deps.logger.debug("lanes_preview_refs_failed", { kind: (error as { kind?: unknown }).kind });
      return [];
    }
  }

  return {
    async preview(caller, projectRoot) {
      ownRoot(caller, projectRoot);
      const real = inBox(caller.userId, projectRoot) ? null : await realpath(projectRoot).catch(() => null);
      const repo = real !== null && (await isMainCheckout(real));
      if (!repo || real === null)
        return {
          repo: false,
          current: null,
          refs: [],
          config: viewOf(caller.userId, projectRoot, NO_FILE),
          remote: null,
          forge: null,
        };
      const [current, refs, file] = await Promise.all([
        currentBranch(real),
        refsOf(real),
        loadFile(caller, real, false),
      ]);
      // The same function as the lane view's `remote` and `forge` (M9R70), read from the main checkout.
      const { remote, forge } = await readRemoteInfo(
        { git, logger: deps.logger, allowFile: deps.allowFile ?? false },
        { root: real },
        forgeLineOf(file),
      ).catch((error: unknown) => {
        if (error instanceof GitError && error.kind === "timeout") throw new PapError("timeout");
        if (error instanceof PapError) throw error;
        deps.logger.debug("lanes_preview_remote_failed", { kind: (error as { kind?: unknown }).kind });
        return NO_REMOTE;
      });
      return { repo: true, current, refs, config: viewOf(caller.userId, projectRoot, file), remote, forge };
    },

    async forgeLine(ownerId, projectRoot) {
      if (!deps.roots(ownerId).includes(projectRoot) || inBox(ownerId, projectRoot)) return undefined;
      const real = await realpath(projectRoot).catch(() => null);
      return real === null ? undefined : forgeLineOf(await loadFile({ kind: "session" }, real, false));
    },

    async approvedScript(ownerId, projectRoot, kind) {
      // A project the owner no longer has, or a file pap may not read, runs nothing.
      if (!deps.roots(ownerId).includes(projectRoot) || inBox(ownerId, projectRoot))
        return { ok: false, reason: "unapproved" };
      const real = await realpath(projectRoot).catch(() => null);
      if (real === null) return { ok: false, reason: "none" };
      const state = await loadFile({ kind: "session" }, real, true);
      if (!state.found || state.read === "unreadable" || !state.read.ok) return { ok: false, reason: "none" };
      const text = state.read.config[kind];
      if (text === undefined) return { ok: false, reason: "none" };
      const stored = approvals.get(ownerId, projectRoot, kind);
      return stored?.sha256 === scriptHash(text) ? { ok: true, text } : { ok: false, reason: "unapproved" };
    },

    async approveScripts(caller, params) {
      if (caller.kind !== "session") throw new PapError("forbidden");
      requireStepUp(caller, deps.clock.now());
      if (deps.readOnly) throw new PapError("read_only");
      ownRoot(caller, params.projectRoot);
      if (inBox(caller.userId, params.projectRoot)) throw new PapError("not_found");
      const wanted = new Map<ScriptKind, string>();
      for (const { kind, sha256 } of params.scripts) {
        if (wanted.get(kind) !== undefined && wanted.get(kind) !== sha256) return CHANGED;
        wanted.set(kind, sha256);
      }
      const real = await realpath(params.projectRoot).catch(() => null);
      if (real === null) throw new PapError("not_found");
      // The decision is bound to the file as it is now: what is hashed here is what is stored, with no await between.
      const state = await loadFile(caller, real, true);
      if (!state.found || state.read === "unreadable" || !state.read.ok) return CHANGED;
      const texts: Array<{ kind: ScriptKind; sha256: string; text: string }> = [];
      for (const [kind, sha256] of wanted) {
        const text = state.read.config[kind];
        if (text === undefined || scriptHash(text) !== sha256) return CHANGED;
        texts.push({ kind, sha256, text });
      }
      deps.db.transaction(() => {
        for (const { kind, sha256, text } of texts)
          approvals.approve(caller.userId, params.projectRoot, kind, sha256, text);
      });
      for (const { kind, sha256 } of texts)
        deps.audit.append({
          ownerId: caller.userId,
          actor: "user",
          kind: "policy",
          reason: "lane_script_approved",
          detail: { project: params.projectRoot.slice(0, AUDIT_PATH_CHARS), kind, sha256 },
        });
      return { ok: true };
    },
  };
}

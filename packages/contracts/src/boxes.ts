import { z } from "zod";
import { AgentResources, SystemPackages } from "./agents-resources.ts";
import { FILE_CHUNK_B64 } from "./file-chunk.ts";
import { BOX_GITHUB_OPS, BOX_GITHUB_RESULTS, BOX_GITHUB_TIMEOUTS } from "./box-github-ops.ts";
import { BOX_SERVICE_OPS, BOX_SERVICE_RESULTS, BOX_SERVICE_TIMEOUTS } from "./box-service-ops.ts";
import { AGENT_LIMITS } from "./agents.ts";
import { Etag, FILE_LIMITS, FilePath, FilesListResult, FilesReadResult, FilesSearchResult } from "./files.ts";
import { AgentHostEntry } from "./host-entry.ts";
import { PreviewDecl } from "./preview-service.ts";
import { DiffSide, RepoPath, VCS_LIMITS, VcsStatus } from "./vcs.ts";

export { BoxRef, ProjectId, boxKey, parseBoxKey } from "./box-ref.ts";

export const BOX_MOUNT = "/boxes";

export interface ProjectBoxPaths {
  readonly root: string;
  readonly project: string;
  readonly home: string;
  readonly inbox: string;
  readonly pi: string;
  readonly sessions: string;
  readonly piAgentDir: string;
}

/** `base` is `/boxes/<id>` in a VM or the process backend's root; contracts also runs in the browser, so no `node:path`. */
export function projectBoxPaths(base: string): ProjectBoxPaths {
  const root = base.length > 1 ? base.replace(/\/+$/, "") : base;
  return {
    root,
    project: `${root}/project`,
    home: `${root}/home`,
    inbox: `${root}/inbox`,
    pi: `${root}/.pi`,
    sessions: `${root}/.pi/sessions`,
    piAgentDir: `${root}/.pi/agent`,
  };
}

export const DEFAULT_PROJECT_RESOURCES: AgentResources = Object.freeze({
  memoryMb: 2048,
  cpus: 2,
  diskMb: 8192,
});
export const ProjectHosts = z.array(AgentHostEntry).max(AGENT_LIMITS.hosts);

export const BoxPhase = z.enum(["stopped", "starting", "running"]);
export type BoxPhase = z.infer<typeof BoxPhase>;

export const BOX_OP_LIMITS = Object.freeze({ inFlight: 8, timeoutMs: 30_000 });
export const BOX_OP_ERRORS = [
  "not_found",
  "conflict",
  "payload_too_large",
  "bad_request",
  "timeout",
  "failed",
] as const;
export const BoxOpError = z.enum(BOX_OP_ERRORS);
export type BoxOpError = z.infer<typeof BoxOpError>;

const Base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const Offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Chunk = z.string().max(FILE_CHUNK_B64).regex(Base64);
const op = <N extends string, S extends z.ZodRawShape>(name: N, shape: S) =>
  z.object({ name: z.literal(name), ...shape }).strict();

/** What the daemon asks a running box's guest (spec boxes, guest ops). */
export const BoxOp = z.discriminatedUnion("name", [
  op("fs.list", { path: FilePath, showIgnored: z.boolean() }),
  op("fs.read", { path: FilePath, offset: Offset }),
  op("fs.write", {
    path: FilePath,
    text: z.string().max(FILE_LIMITS.editableBytes),
    baseEtag: Etag.nullable(),
  }),
  op("fs.put", {
    id: z.string().regex(/^[0-9a-f]{32}$/),
    path: FilePath,
    offset: Offset,
    data: Chunk,
    last: z.boolean(),
    conflict: z.enum(["skip", "replace"]),
  }),
  op("fs.get", { path: FilePath, offset: Offset }),
  op("fs.search", {
    query: z.string().min(1).max(FILE_LIMITS.searchQuery),
    limit: z.number().int().min(1).max(FILE_LIMITS.searchResults),
  }),
  op("git.status", {}),
  op("git.blob", { path: RepoPath, oldPath: RepoPath.optional(), side: DiffSide }),
  op("knowledge.state", {}),
  op("knowledge.enable", {}),
  op("project.config", {}),
  ...BOX_GITHUB_OPS,
  ...BOX_SERVICE_OPS,
]);
export type BoxOp = z.infer<typeof BoxOp>;
export type BoxOpName = BoxOp["name"];
export type BoxOpArgs<N extends BoxOpName = BoxOpName> = Extract<BoxOp, { name: N }>;

export const BOX_OP_RESULTS = {
  "fs.list": FilesListResult,
  "fs.read": FilesReadResult,
  "fs.write": z.object({ etag: Etag }).strict(),
  "fs.put": z.object({ done: z.boolean(), skipped: z.boolean() }).strict(),
  "fs.get": z.object({ data: Chunk, size: Offset, nextOffset: Offset.nullable() }).strict(),
  "fs.search": FilesSearchResult,
  "git.status": VcsStatus,
  "git.blob": z
    .object({
      text: z.string().max(VCS_LIMITS.diffSideBytes).nullable(),
      binary: z.boolean(),
      truncated: z.boolean(),
    })
    .strict(),
  "knowledge.state": z.object({ enabled: z.boolean(), concepts: Offset }).strict(),
  "knowledge.enable": z.object({ enabled: z.literal(true) }).strict(),
  "project.config": z
    .object({
      packages: SystemPackages.nullable(),
      error: z.enum(["too_large", "invalid_yaml", "not_a_map", "bad_packages"]).nullable(),
      preview: PreviewDecl.nullable(),
      previewInvalid: z.boolean(),
    })
    .strict(),
  ...BOX_GITHUB_RESULTS,
  ...BOX_SERVICE_RESULTS,
} as const satisfies { readonly [N in BoxOpName]: z.ZodType };

/** Milliseconds a guest op may take: the clone and the push are slower than the rest. */
export const BOX_OP_TIMEOUTS: Record<BoxOpName, number> = {
  "fs.list": BOX_OP_LIMITS.timeoutMs,
  "fs.read": BOX_OP_LIMITS.timeoutMs,
  "fs.write": BOX_OP_LIMITS.timeoutMs,
  "fs.put": BOX_OP_LIMITS.timeoutMs,
  "fs.get": BOX_OP_LIMITS.timeoutMs,
  "fs.search": BOX_OP_LIMITS.timeoutMs,
  "git.status": BOX_OP_LIMITS.timeoutMs,
  "git.blob": BOX_OP_LIMITS.timeoutMs,
  "knowledge.state": BOX_OP_LIMITS.timeoutMs,
  "knowledge.enable": BOX_OP_LIMITS.timeoutMs,
  "project.config": BOX_OP_LIMITS.timeoutMs,
  "git.clone": BOX_GITHUB_TIMEOUTS["git.clone"],
  "git.link": BOX_OP_LIMITS.timeoutMs,
  "git.unlink": BOX_OP_LIMITS.timeoutMs,
  "git.commit": BOX_OP_LIMITS.timeoutMs,
  "git.push": BOX_GITHUB_TIMEOUTS["git.push"],
  "github.token": BOX_OP_LIMITS.timeoutMs,
  "github.identity": BOX_OP_LIMITS.timeoutMs,
  "github.forgetKey": BOX_OP_LIMITS.timeoutMs,
  ...BOX_SERVICE_TIMEOUTS,
};
export type BoxOpValue<N extends BoxOpName = BoxOpName> = z.output<(typeof BOX_OP_RESULTS)[N]>;

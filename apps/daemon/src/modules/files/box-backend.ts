import { randomBytes } from "node:crypto";
import {
  type Caller,
  FILE_CHUNK_BYTES,
  FILE_LIMITS,
  type FileMeta,
  PapError,
  type ParamsOf,
  type ResultOf,
  type UploadAnswer,
} from "@pap/contracts";
import type { BoxOps, ProjectBoxSource } from "../../kernel/boxes.ts";
import { type AgentFilesSource, agentOfPath, underAgents } from "../../kernel/agent-path.ts";
import { type IsMember, routeBoxPath } from "../../kernel/box-path.ts";
import type { Clock } from "../../kernel/clock.ts";
import {
  entryIsProtected,
  judgeBoxName,
  NO_HOST_BOUNDARY,
  type Protection,
  protectionOf,
  type Scope,
  gateWrite,
} from "../../kernel/fs/boundary.ts";
import { uploadName } from "../../kernel/fs/names.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { UploadInput } from "./upload.ts";

/** A project's folder, or an agent's folder (`/agents/<id>`); `guestRoot` is where it lies in the guest (the same path for a project). */
export interface BoxTarget {
  readonly kind: "project" | "agent";
  readonly id: string;
  readonly root: string;
  readonly guestRoot: string;
  /** Paths relative to `root` (rooted, like `/home/.kube/config`) that are never listed, read, written or searched. */
  readonly hidden: ReadonlySet<string>;
}

export interface BoxRaw {
  readonly size: number;
  /** The guest's chunks in order; the first one is already fetched, so a refusal comes before the response starts. */
  readonly body: ReadableStream<Uint8Array>;
}

export interface BoxFilesDeps {
  readonly boxes: () => ProjectBoxSource | undefined;
  readonly ops: () => BoxOps | undefined;
  readonly agentOps: () => BoxOps | undefined;
  readonly agents: () => AgentFilesSource | undefined;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly readOnly: boolean;
  readonly isMember: IsMember;
}

export interface BoxFiles {
  /** The box a path of the caller's belongs to, or null (a host path, or no box source bound); `forbidden` for a member's host path. */
  match(caller: Caller, path: string): BoxTarget | null;
  /**
   * The agent's folder a path of the caller's belongs to, or null when the path is not under `/agents`. A path under `/agents` that
   * is not the caller's own agent's (a token, another user's or an unknown agent, an odd spelling) is `not_found`: it never
   * falls through to the host (R2).
   */
  matchAgent(caller: Caller, path: string): BoxTarget | null;
  list(target: BoxTarget, caller: Caller, params: ParamsOf<"files.list">): Promise<ResultOf<"files.list">>;
  read(target: BoxTarget, caller: Caller, params: ParamsOf<"files.read">): Promise<ResultOf<"files.read">>;
  search(
    target: BoxTarget,
    caller: Caller,
    params: ParamsOf<"files.search">,
  ): Promise<ResultOf<"files.search">>;
  write(target: BoxTarget, caller: Caller, params: ParamsOf<"files.write">): Promise<ResultOf<"files.write">>;
  upload(target: BoxTarget, caller: Caller, input: UploadInput): Promise<UploadAnswer>;
  openRaw(target: BoxTarget, caller: Caller, path: string): Promise<BoxRaw>;
}

const NONE: ReadonlySet<string> = new Set();
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** `files.*` and the raw routes for a path of a box project: the guest does the work, the daemon judges the path's name. */
export function createBoxFiles(deps: BoxFilesDeps): BoxFiles {
  const ops = (target: BoxTarget): BoxOps => {
    const bound = target.kind === "agent" ? deps.agentOps() : deps.ops();
    if (bound === undefined) throw new PapError("box_stopped");
    return bound;
  };
  /** An agent's home is `/home` of its folder: a dot-entry there is protected like the daemon's home, a project has no host boundary. */
  const scopeOf = (caller: Caller, target: BoxTarget): Scope =>
    target.kind === "agent"
      ? { roots: ["/"], config: { ...NO_HOST_BOUNDARY, home: ["/home"] }, caller: caller.kind }
      : { roots: [], config: NO_HOST_BOUNDARY, caller: caller.kind };
  /** The path relative to the box's folder, as a rooted candidate for the pattern rules. */
  const candidate = (target: BoxTarget, path: string): string => path.slice(target.root.length) || "/";
  /** The pap path in the guest's form: the box's folder swapped for where it lies there. */
  const guestPath = (target: BoxTarget, path: string): string =>
    target.guestRoot + path.slice(target.root.length);
  /** What the path's name allows this caller (a token never sees what the boundary hides); the guest judges containment and links. */
  const protectionFor = (target: BoxTarget, caller: Caller, path: string): Protection => {
    const name = candidate(target, path);
    if (target.hidden.has(name) || judgeBoxName(name, caller.kind) !== null) throw new PapError("not_found");
    return protectionOf(name, scopeOf(caller, target));
  };
  const gate = (caller: Caller, protection: Protection, confirmProtected: boolean): void => {
    const verdict = gateWrite({ protection, caller, confirmProtected, now: deps.clock.now() });
    if (verdict !== "ok") {
      deps.logger.debug("file_write_gated", { gate: verdict, protection, callerKind: caller.kind });
      throw new PapError(verdict);
    }
  };
  const writable = (): void => {
    if (deps.readOnly) throw new PapError("read_only");
  };

  async function put(target: BoxTarget, input: UploadInput, path: string): Promise<number | null> {
    const id = randomBytes(16).toString("hex");
    let offset = 0;
    let pending = Buffer.alloc(0);
    const send = async (data: Buffer, last: boolean): Promise<boolean> => {
      const answer = await ops(target).call(target.id, {
        name: "fs.put",
        id,
        path: guestPath(target, path),
        offset,
        data: b64(data),
        last,
        conflict: input.conflict,
      });
      offset += data.length;
      return answer.skipped;
    };
    for await (const chunk of input.chunks) {
      pending = Buffer.concat([pending, chunk]);
      // A chunk goes only when more bytes are known to follow it, so the last one carries `last`.
      while (pending.length > FILE_CHUNK_BYTES) {
        if (await send(pending.subarray(0, FILE_CHUNK_BYTES), false)) return null;
        pending = pending.subarray(FILE_CHUNK_BYTES);
      }
    }
    return (await send(pending, true)) ? null : offset;
  }

  return {
    match: (caller, path) => {
      const found = routeBoxPath(deps, deps.boxes(), caller.userId, path);
      return (
        found && {
          kind: "project",
          id: found.projectId,
          root: found.root,
          guestRoot: found.root,
          hidden: NONE,
        }
      );
    },
    matchAgent(caller, path) {
      if (!underAgents(path)) return null;
      const found = agentOfPath(path);
      const source = deps.agents();
      if (caller.kind === "token" || found === null || source === undefined) throw new PapError("not_found");
      const guestRoot = source.guestRootOf(caller.userId, found.agentId);
      if (guestRoot === null) throw new PapError("not_found");
      const hidden = new Set(source.importedOf(found.agentId).map((imported) => `/home/${imported}`));
      return { kind: "agent", id: found.agentId, root: found.root, guestRoot, hidden };
    },
    async list(target, caller, { path, showIgnored }) {
      protectionFor(target, caller, path);
      const listing = await ops(target).call(target.id, {
        name: "fs.list",
        path: guestPath(target, path),
        showIgnored: showIgnored === true,
      });
      // Like the host listing: an entry the caller may not open is listed as `protected`, never browsable.
      const folder = candidate(target, path).replace(/\/$/, "");
      const entries = listing.entries
        .filter((entry) => !target.hidden.has(`${folder}/${entry.name}`))
        .map((entry) =>
          entry.protected || !entryIsProtected(`${folder}/${entry.name}`, scopeOf(caller, target))
            ? entry
            : { ...entry, protected: true },
        );
      return { ...listing, entries };
    },
    async read(target, caller, { path, offset }) {
      protectionFor(target, caller, path);
      const read = await ops(target).call(target.id, {
        name: "fs.read",
        path: guestPath(target, path),
        offset: offset ?? 0,
      });
      return target.kind === "agent" ? { ...read, meta: { ...read.meta, path } } : read;
    },
    async search(target, caller, { root, query, limit }) {
      if (root !== target.root) throw new PapError("not_found");
      const found = await ops(target).call(target.id, {
        name: "fs.search",
        query,
        limit: limit ?? FILE_LIMITS.searchResults,
      });
      const shown = found.paths.filter(
        (path) => !target.hidden.has(`/${path}`) && judgeBoxName(`/${path}`, caller.kind) === null,
      );
      return { paths: shown, truncated: found.truncated };
    },
    async write(target, caller, params) {
      writable();
      const { path, text, baseEtag } = params;
      const size = Buffer.byteLength(text, "utf8");
      if (size > FILE_LIMITS.editableBytes || sizeOf(text) > PAGE_BYTES)
        throw new PapError("payload_too_large");
      const protection = protectionFor(target, caller, path);
      gate(caller, protection, params.confirmProtected === true);
      const { etag } = await ops(target).call(target.id, {
        name: "fs.write",
        path: guestPath(target, path),
        text,
        baseEtag,
      });
      deps.logger.info("file_written", { protection, callerKind: caller.kind, box: true });
      const meta: FileMeta = {
        path,
        size,
        mtimeMs: Math.max(0, deps.clock.now()),
        etag,
        binary: false,
        editable: sizeOf(text) <= PAGE_BYTES,
        protection,
      };
      return { meta };
    },
    async upload(target, caller, input) {
      writable();
      const cut = input.path.lastIndexOf("/");
      const name = uploadName(input.path.slice(cut + 1));
      if (cut < 0 || name === null) throw new PapError("bad_request");
      const path = input.path.slice(0, cut + 1) + name;
      const protection = protectionFor(target, caller, path);
      gate(caller, protection, input.confirmProtected);
      const size = await put(target, input, path);
      if (size === null) return { written: false };
      deps.logger.info("file_uploaded", { protection, callerKind: caller.kind, box: true });
      const meta: FileMeta = {
        path,
        size,
        mtimeMs: Math.max(0, deps.clock.now()),
        etag: null,
        binary: false,
        editable: false,
        protection,
      };
      return { written: true, meta };
    },
    async openRaw(target, caller, path) {
      protectionFor(target, caller, path);
      const abort = new AbortController();
      const fetchAt = (offset: number) =>
        ops(target).call(target.id, { name: "fs.get", path: guestPath(target, path), offset }, abort.signal);
      let current = await fetchAt(0);
      const { size } = current;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            controller.enqueue(new Uint8Array(Buffer.from(current.data, "base64")));
            if (current.nextOffset === null) return controller.close();
            current = await fetchAt(current.nextOffset);
          } catch (error) {
            controller.error(error);
          }
        },
        cancel: () => abort.abort(),
      });
      return { size, body };
    },
  };
}

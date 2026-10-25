import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import { randomToken } from "../../kernel/ids.ts";
import type { Logger } from "../../kernel/logger.ts";

/** How long a download link lives. The clock is the kernel's, so a test advances it. */
export const EXPORT_TTL_MS = 600_000;
export const MAX_PENDING_EXPORTS = 16;
/** The names pap gives its own files (`randomUUID`), and the half-patched copy beside one. */
const OWN_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.html(?:\.patching)?$/;
/** What a token and a session id may look like in a URL; anything else never reaches a lookup. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface Exports {
  /**
   * A token for an export of this session by this owner, and the one path the worker writes it to. Past
   * `MAX_PENDING_EXPORTS` it throws `capacity`. `title` is the name the download is saved under.
   */
  prepare(sessionId: string, ownerId: string, title?: string | null): { token: string; path: string };
  /**
   * The path of the pending export, once: the entry is gone (and its timer cleared) before this returns. A token that
   * is unknown, expired, used or bound to another session or owner answers null, and the entry of a wrong caller is
   * left to its owner.
   */
  take(token: string, sessionId: string, ownerId: string): { path: string; title: string | null } | null;
  /** Forgets the token and deletes its file (and the half-patched copy beside it). */
  discard(token: string): void;
  /** Every pending export of this owner (a deleted member, A5b). */
  discardOwner(ownerId: string): void;
  /** Empties the directory: what an earlier daemon left behind, at boot. */
  purgeAll(): void;
  /** Deletes every pending file, clears every timer and takes no more. */
  stop(): void;
}

interface Pending {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly title: string | null;
  readonly path: string;
  readonly timer: TimerHandle;
}

export interface ExportsDeps {
  readonly dir: string;
  readonly clock: Clock;
  readonly logger: Logger;
  newToken?(): string;
}

/**
 * The exports waiting to be downloaded, in memory only: a restart forgets them and boot deletes their files (M2R96).
 * A file lives until its download starts (the route deletes it as soon as it holds the file open), its TTL ends, or the
 * export is discarded.
 */
export function createExports(deps: ExportsDeps): Exports {
  const newToken = deps.newToken ?? randomToken;
  const pending = new Map<string, Pending>();
  let stopped = false;
  mkdirSync(deps.dir, { recursive: true, mode: 0o700 });
  // An earlier run, or a person, may have left it more open.
  chmodSync(deps.dir, 0o700);

  const remove = (path: string): void => {
    for (const target of [path, `${path}.patching`]) {
      try {
        rmSync(target, { force: true });
      } catch (error) {
        deps.logger.warn("export_delete_failed", {
          code: (error as NodeJS.ErrnoException).code ?? "unknown",
        });
      }
    }
  };

  const forget = (token: string): Pending | undefined => {
    const entry = pending.get(token);
    if (!entry) return undefined;
    pending.delete(token);
    deps.clock.clearTimeout(entry.timer);
    return entry;
  };

  const exports: Exports = {
    prepare(sessionId, ownerId, title = null) {
      if (stopped || pending.size >= MAX_PENDING_EXPORTS) throw new PapError("capacity");
      const token = newToken();
      // The file's name is its own: it never derives from the token, a secret, or from anything a client sent.
      const path = join(deps.dir, `${randomUUID()}.html`);
      const timer = deps.clock.setTimeout(() => {
        const entry = forget(token);
        if (entry) remove(entry.path);
      }, EXPORT_TTL_MS);
      pending.set(token, { sessionId, ownerId, title, path, timer });
      return { token, path };
    },
    take(token, sessionId, ownerId) {
      if (!TOKEN_PATTERN.test(token)) return null;
      const entry = pending.get(token);
      if (!entry || entry.sessionId !== sessionId || entry.ownerId !== ownerId) return null;
      forget(token);
      return { path: entry.path, title: entry.title };
    },
    discard(token) {
      const entry = forget(token);
      if (entry) remove(entry.path);
    },
    discardOwner(ownerId) {
      for (const [token, entry] of [...pending])
        if (entry.ownerId === ownerId) {
          forget(token);
          remove(entry.path);
        }
    },
    purgeAll() {
      for (const token of [...pending.keys()]) forget(token);
      let names: string[] = [];
      try {
        names = readdirSync(deps.dir);
      } catch (error) {
        deps.logger.warn("export_purge_failed", { code: (error as NodeJS.ErrnoException).code ?? "unknown" });
      }
      let kept = 0;
      for (const name of names) {
        const path = join(deps.dir, name);
        try {
          // lstat: a link is never followed, and a folder is never entered. Only pap's own regular files go.
          if (OWN_FILE.test(name) && lstatSync(path).isFile()) rmSync(path, { force: true });
          else kept++;
        } catch (error) {
          deps.logger.warn("export_delete_failed", {
            code: (error as NodeJS.ErrnoException).code ?? "unknown",
          });
        }
      }
      if (kept > 0) deps.logger.warn("export_purge_kept", { count: kept });
    },
    stop() {
      stopped = true;
      for (const token of [...pending.keys()]) exports.discard(token);
    },
  };
  return exports;
}

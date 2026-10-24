import { PapError } from "@pap/contracts";
import { z } from "zod";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { GithubCore } from "./index.ts";
import type { GithubProjectRow, GithubProjectStore } from "./project-store.ts";

export const SWEEP_MS = 24 * 60 * 60_000;

const Created = z.object({ id: z.number().int().positive() });
const codeOf = (error: unknown): string => (error instanceof PapError ? error.code : "error");

export type KeyUpload = "added" | "permission" | "failed";

export interface ProjectKeys {
  /** Adds the project's signing key to the owner's GitHub account once (`pap <project name> <first 8 of the id>`). */
  ensure(row: GithubProjectRow, publicKey: string): Promise<KeyUpload>;
  /**
   * Removes the key from GitHub through the owner's user token. True when it is gone (or never was); false keeps
   * `key_state: failed` for the daily sweep.
   */
  remove(row: GithubProjectRow): Promise<boolean>;
  /** The project is unlinked or deleted: its key goes, and the row with it unless the removal failed (then it is unlinked and kept). */
  release(row: GithubProjectRow): Promise<void>;
  /** Retries every failed removal. */
  sweep(): Promise<void>;
  /** Runs the sweep now and then every day on the clock. */
  start(): void;
  stop(): void;
}

export function createKeys(deps: {
  readonly core: GithubCore;
  readonly store: GithubProjectStore;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The project's name for the key title; null once the project is gone. */
  nameOf(ownerId: string, projectId: string): string | null;
  /** A 403 on the upload: the App lacks the SSH signing keys permission. */
  permissionMissing(): void;
}): ProjectKeys {
  const { core, store, clock, logger } = deps;
  let timer: TimerHandle | undefined;

  const titleOf = (row: GithubProjectRow): string =>
    `pap ${deps.nameOf(row.ownerId, row.projectId) ?? "project"} ${row.projectId.slice(0, 8)}`;

  async function ensure(row: GithubProjectRow, publicKey: string): Promise<KeyUpload> {
    if (row.keyState === "added" && row.keyId !== null) return "added";
    try {
      const token = await core.userTokens.get(row.ownerId);
      const created = await core.client.json(Created, {
        method: "POST",
        path: "/user/ssh_signing_keys",
        auth: { kind: "bearer", value: token },
        body: { title: titleOf(row), key: publicKey },
      });
      store.setKey(row.projectId, created.id, "added");
      return "added";
    } catch (error) {
      if (error instanceof PapError && error.code === "forbidden") {
        deps.permissionMissing();
        logger.warn("github_key_permission_missing");
        return "permission";
      }
      logger.warn("github_key_upload_failed", { code: codeOf(error) });
      return "failed";
    }
  }

  async function remove(row: GithubProjectRow): Promise<boolean> {
    if (row.keyId === null) return true;
    store.setKey(row.projectId, row.keyId, "removing");
    try {
      const token = await core.userTokens.get(row.ownerId);
      await core.client.text({
        method: "DELETE",
        path: `/user/ssh_signing_keys/${row.keyId}`,
        auth: { kind: "bearer", value: token },
      });
    } catch (error) {
      // 404: the owner removed it on GitHub already.
      if (!(error instanceof PapError && error.code === "not_found")) {
        store.setKey(row.projectId, row.keyId, "failed");
        logger.warn("github_key_removal_failed", { code: codeOf(error) });
        return false;
      }
    }
    store.setKey(row.projectId, null, "absent");
    return true;
  }

  async function release(stale: GithubProjectRow): Promise<void> {
    // The row as it is now: a delivery may have uploaded the key since the caller read it.
    const row = store.get(stale.projectId);
    if (!row) return;
    if (await remove(row)) store.remove(row.projectId);
    else store.setLinked(row.projectId, false);
  }

  async function sweep(): Promise<void> {
    for (const row of store.withPendingRemoval()) {
      if (!(await remove(row))) continue;
      if (!row.linked) store.remove(row.projectId);
    }
  }

  const arm = (): void => {
    timer = clock.setTimeout(() => {
      void sweep()
        .catch((error: unknown) => logger.warn("github_key_sweep_failed", { code: codeOf(error) }))
        .finally(() => {
          if (timer !== undefined) arm();
        });
    }, SWEEP_MS);
  };

  return {
    ensure,
    remove,
    release,
    sweep,
    start() {
      if (timer !== undefined) return;
      void sweep().catch((error: unknown) => logger.warn("github_key_sweep_failed", { code: codeOf(error) }));
      arm();
    },
    stop() {
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    },
  };
}

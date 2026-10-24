import { type BoxPhase, PapError, type RepoFullName } from "@pap/contracts";
import { z } from "zod";
import type { BoxControl, BoxOps, ProjectBoxSource } from "../../kernel/boxes.ts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { GithubCore } from "./index.ts";
import type { ProjectKeys } from "./keys.ts";
import type { CloneError, GithubProjectStore } from "./project-store.ts";
import { BOX_PERMISSIONS } from "./tokens.ts";

/** A box token lasts an hour; it is renewed every 45 minutes while the box runs. */
export const RENEW_MS = 45 * 60_000;
/** A token that could not be delivered is tried again after a minute, until it is, then back to the renewal. */
export const RETRY_MS = 60_000;

const User = z.object({
  login: z.string().min(1).max(64),
  id: z.number().int().positive(),
  name: z.string().max(256).nullable().optional(),
});
const codeOf = (error: unknown): string => (error instanceof PapError ? error.code : "error");

/** The fixed word a failed clone is stored with: the guest reports only its op error codes. */
export function cloneErrorOf(error: unknown): CloneError {
  switch (codeOf(error)) {
    case "not_found":
      return "not_found";
    case "forbidden":
    case "github_unavailable":
      return "auth";
    case "timeout":
    case "network":
      return "network";
    default:
      return "failed";
  }
}

export interface Delivery {
  /** Delivers now (awaited, never throws) and renews every 45 minutes while the box runs. */
  begin(projectId: string): Promise<void>;
  /** Stops renewing and revokes the box token last delivered: the project is unlinked or deleted. Never rejects. */
  forget(projectId: string): Promise<void>;
  /** Runs `work` after the delivery in progress for the project, before the next one. */
  exclusive(projectId: string, work: () => Promise<void>): Promise<void>;
  /** Follows the box phases: a box that is running is delivered to, one that is not stops being renewed. */
  start(): () => void;
}

export function createDelivery(deps: {
  readonly core: GithubCore;
  readonly store: GithubProjectStore;
  readonly keys: ProjectKeys;
  readonly control: BoxControl;
  readonly ops: BoxOps;
  readonly source: ProjectBoxSource;
  readonly clock: Clock;
  readonly logger: Logger;
}): Delivery {
  const { core, store, keys, control, ops, source, clock, logger } = deps;
  const timers = new Map<string, TimerHandle>();
  /** One delivery at a time per project: a renewal waits for a clone in progress. */
  const chains = new Map<string, Promise<void>>();
  /** The box token last delivered, for the revoke when the project is unlinked or deleted. */
  const delivered = new Map<string, string>();

  const disarm = (projectId: string): void => {
    const timer = timers.get(projectId);
    if (timer !== undefined) clock.clearTimeout(timer);
    timers.delete(projectId);
  };
  const arm = (projectId: string, delay: number): void => {
    disarm(projectId);
    timers.set(
      projectId,
      clock.setTimeout(() => {
        timers.delete(projectId);
        if (control.phase(projectId) !== "running") return;
        void serial(projectId, () => deliver(projectId, false));
      }, delay),
    );
  };
  function serial(projectId: string, work: () => Promise<void>): Promise<void> {
    const next = (chains.get(projectId) ?? Promise.resolve()).then(work, work);
    const tail = next.finally(() => {
      if (chains.get(projectId) === tail) chains.delete(projectId);
    });
    chains.set(projectId, tail);
    return tail;
  }

  /** A step that fails is logged with a fixed code and retried at the next tick; it never reaches the box's start. */
  async function step(name: string, projectId: string, run: () => Promise<void>): Promise<boolean> {
    try {
      await run();
      return true;
    } catch (error) {
      logger.warn("github_delivery_failed", { step: name, projectId, code: codeOf(error) });
      return false;
    }
  }

  async function sendToken(projectId: string, repository: RepoFullName) {
    // Never `administration`: the token reaches this one repository with contents and pull requests only.
    const minted = await core.tokens.mint(repository, BOX_PERMISSIONS);
    await ops.poll(projectId, {
      name: "github.token",
      token: minted.token,
      expiresAt: new Date(minted.expiresAt).toISOString(),
    });
    delivered.set(projectId, minted.token);
  }

  async function sendIdentity(projectId: string): Promise<void> {
    const row = store.get(projectId);
    if (!row?.linked) return;
    const token = await core.userTokens.get(row.ownerId);
    const me = await core.client.json(User, { path: "/user", auth: { kind: "bearer", value: token } });
    const { publicKey } = await ops.poll(projectId, {
      name: "github.identity",
      login: me.login,
      displayName: me.name?.trim() || me.login,
      email: `${me.id}+${me.login}@users.noreply.github.com`,
    });
    await keys.ensure(row, publicKey);
  }

  /** Clones when `project/` is empty and the row is new; a folder that already holds files is left alone. */
  async function cloneIfNew(projectId: string): Promise<void> {
    const row = store.get(projectId);
    const box = source.box(projectId);
    if (!row || row.cloneState !== "pending" || !box) return;
    const listing = await ops.poll(projectId, { name: "fs.list", path: box.root, showIgnored: true });
    if (listing.entries.length > 0) {
      store.setClone(projectId, "done", null);
      logger.info("github_clone_skipped", { projectId });
      return;
    }
    try {
      await ops.poll(projectId, {
        name: "git.clone",
        url: core.cloneUrl(row.repository),
        upstream: row.upstream === null ? null : core.cloneUrl(row.upstream),
      });
      store.setClone(projectId, "done", null);
    } catch (error) {
      // A box that stopped mid-clone is not a failed clone: the row stays `pending` for the next start.
      if (error instanceof PapError && error.code === "box_stopped") throw error;
      store.setClone(projectId, "failed", cloneErrorOf(error));
      logger.warn("github_clone_failed", { projectId, error: cloneErrorOf(error) });
    }
  }

  async function deliver(projectId: string, first: boolean): Promise<void> {
    const row = store.get(projectId);
    const box = source.box(projectId);
    if (!row || !row.linked || !box || box.deleting) return;
    const sent = await step("token", projectId, () => sendToken(projectId, row.repository));
    // The next delivery is armed first: a clone can take minutes. A failed token waits a minute, not 45.
    if (control.phase(projectId) === "running") arm(projectId, sent ? RENEW_MS : RETRY_MS);
    // Without a token the clone of a private repository would fail for good: identity and clone wait for the retry.
    if (!sent) return;
    if (first || row.keyState !== "added") await step("identity", projectId, () => sendIdentity(projectId));
    await step("clone", projectId, () => cloneIfNew(projectId));
  }

  async function begin(projectId: string): Promise<void> {
    const row = store.get(projectId);
    if (!row || !row.linked) return;
    await serial(projectId, () => deliver(projectId, true));
  }

  return {
    begin,
    async forget(projectId) {
      disarm(projectId);
      const token = delivered.get(projectId);
      delivered.delete(projectId);
      if (token === undefined) return;
      try {
        await core.tokens.revoke(token);
      } catch {
        logger.warn("github_token_revoke_failed", { projectId });
      }
    },
    exclusive: serial,
    start() {
      const off = control.onPhase((projectId, phase: BoxPhase) => {
        if (phase === "running") void begin(projectId);
        else disarm(projectId);
      });
      return () => {
        off();
        for (const projectId of [...timers.keys()]) disarm(projectId);
      };
    },
  };
}

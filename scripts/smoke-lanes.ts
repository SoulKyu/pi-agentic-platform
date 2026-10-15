// The smoke's lanes step: the built daemon creates a lane in a temporary repository (no scripts, no forge), the scripted
// provider writes one file in the lane's worktree, the file is committed and the lane archived. The lanes module, its
// git runner and its migrations must work from the compiled daemon, which only this step proves.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asJson, isPi, type Json, openSession, type SmokeSocket, step } from "./smoke-lib.ts";

const FILE = "smoke-lane.txt";
const WROTE = "The lane file is written.";
const ARCHIVE_WAIT_MS = 30_000;
const POLL_MS = 100;

export interface LanesContext {
  readonly port: number;
  readonly origin: string;
  readonly cookie: string;
  /** The smoke's temporary root: the repository is made beside the smoke session's folder. */
  readonly root: string;
  readonly userHome: string;
  /** Confirms the owner's password for this login (`POST /auth/confirm`): the archive asks for it. */
  readonly stepUp: () => Promise<void>;
}

function makeRepository(root: string, userHome: string): string {
  const repo = join(root, "lanes-repo");
  mkdirSync(repo);
  writeFileSync(join(userHome, ".gitconfig"), "[user]\n\tname = Smoke\n\temail = smoke@example.com\n");
  const env = { PATH: process.env.PATH, HOME: userHome, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "smoke\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return realpathSync(repo);
}

const textOf = (event: Json): string => JSON.stringify(event);
const laneActive = (id: string) => (event: Json) => {
  const lane = event.kind === "lane" ? asJson(event.lane) : null;
  const listed = event.kind === "snapshot" && Array.isArray(event.lanes) ? event.lanes : [];
  return [lane, ...listed.map(asJson)].some(
    (one) => one?.id === id && one.state === "active" && typeof one.primarySessionId === "string",
  );
};

const holdsDialog = (event: Json): boolean => dialogOf(event) !== null;
/** The approval a frame carries: a `dialog_open` event, or a snapshot that already lists one. */
function dialogOf(event: Json): Json | null {
  if (event.kind === "dialog_open") return asJson(event.dialog);
  if (event.kind === "snapshot" && Array.isArray(event.dialogs) && event.dialogs.length > 0)
    return asJson(event.dialogs[0]);
  return null;
}

/** Run after the daemon answers: a lane in its own repository, one committed file, then the archive. */
export async function checkLanes(context: LanesContext): Promise<void> {
  const repo = makeRepository(context.root, context.userHome);
  const socket: SmokeSocket = await openSession(context.port, context.origin, context.cookie);
  try {
    await context.stepUp();
    await socket.call("sessions.create", { cwd: repo }, true);
    await socket.call("subscribe.lane", {});
    const created = asJson(
      await socket.call(
        "lanes.create",
        { projectRoot: repo, title: "Smoke lane", description: "write one file", models: [null] },
        true,
      ),
    );
    const laneId = String((created.laneIds as unknown[])[0]);
    const active = await socket.waitFor(laneActive(laneId), "the lane to become active");
    const lane = [active.lane, ...(Array.isArray(active.lanes) ? active.lanes : [])]
      .map((one) => asJson(one))
      .find((one) => one.id === laneId) as Json;
    const sessionId = String(lane.primarySessionId);
    const worktree = String(lane.worktree);
    step(`lane ${laneId} active in its worktree`);

    // The lane's worker walks the smoke script from its first step: the same bash call the first session made.
    const watcher = await openSession(context.port, context.origin, context.cookie);
    try {
      await watcher.call("subscribe.session", { sessionId });
      // The run is already under way when this socket subscribes: an approval that opened first is only in the
      // snapshot's `dialogs`, one that opens later arrives as `dialog_open`. Either order must work.
      const first = await watcher.waitFor(
        (event) => holdsDialog(event) || isPi("agent_settled")(event),
        "the lane's first run to ask or settle",
      );
      const dialog = dialogOf(first);
      if (dialog !== null) {
        await watcher.call(
          "sessions.respondDialog",
          { sessionId, dialogId: String(dialog.id), response: { answer: "once" } },
          true,
        );
        await watcher.waitFor(isPi("agent_settled"), "the lane's first run to settle");
      }
      await socket.call("sessions.prompt", { sessionId, text: "Write the file" }, true);
      await watcher.waitFor(
        (event) => isPi("message_end")(event) && textOf(event).includes(WROTE),
        "the lane's second run to write the file",
      );
    } finally {
      watcher.close();
    }
    if (!existsSync(join(worktree, FILE))) throw new Error(`the scripted agent did not write ${FILE}`);

    const committed = asJson(
      await socket.call("lanes.commit", { laneId, paths: [FILE], message: "Add the smoke file" }, true),
    );
    if (committed.ok !== true || typeof committed.oid !== "string")
      throw new Error(`lanes.commit answered ${JSON.stringify(committed)}`);
    step(`lane commit ${committed.oid.slice(0, 8)}`);

    const deadline = Date.now() + ARCHIVE_WAIT_MS;
    for (;;) {
      const archived = asJson(
        await socket.call("lanes.archive", { laneId, force: false, deleteBranch: false }, true),
      );
      if (archived.ok === true) break;
      // Busy: the second run is still ending. Anything else is a refusal the smoke cannot get past.
      if (archived.reason !== "busy" || Date.now() > deadline)
        throw new Error(`lanes.archive answered ${JSON.stringify(archived)}`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    if (existsSync(worktree)) throw new Error("the archived lane's worktree is still there");
    step("lane archived, worktree gone");
  } finally {
    socket.close();
  }
}

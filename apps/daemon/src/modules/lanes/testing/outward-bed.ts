import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventFrame, LaneView } from "@pap/contracts";
import type { Config } from "../../../kernel/config.ts";
import type { Logger } from "../../../kernel/logger.ts";
import { expect, vi } from "vitest";
import { createGitBed, type GitBed } from "../../../kernel/testing/git-bed.ts";
import { startTestDaemon, type TestDaemon } from "../../../testing/harness.ts";
import { type StubAnswer, type StubForge, writeStubForge } from "../../../testing/stub-forge.ts";
import type { TestClient } from "../../../testing/ws-client.ts";

export const FORGE_URL = "https://github.com/test/repo.git";
const TIMEOUT = 60_000;

/**
 * A daemon over a real repository whose `origin` is the forge URL `FORGE_URL`, rewritten to a local bare repository by a
 * GLOBAL `url.<bare>.insteadOf` in the daemon's HOME (the push test seam, `file` in the test protocols), a stub `gh`
 * first on PATH, and the owner's identity in that HOME. No network, never the real gh, `~/.ssh` or `~/.pap`.
 */
export interface OutwardBed {
  readonly t: TestDaemon;
  readonly repo: GitBed;
  readonly bare: string;
  readonly stub: StubForge;
  readonly owner: TestClient;
  readonly projectRoot: string;
  readonly laneSub: string;
  /** A lane created through `lanes.create` and waited for until it is active. */
  createLane(title?: string): Promise<LaneView>;
  views(laneId: string): LaneView[];
  stop(): Promise<void>;
}

export async function startOutwardBed(
  answers: readonly StubAnswer[] = [{}],
  extraEnv: Readonly<Record<string, string>> = {},
  /** The provider script (default: three plain replies) and the daemon's logger (a test reads what reached it). */
  extra: {
    readonly steps?: readonly object[];
    readonly logger?: Logger;
    /** Daemon settings (a group of lanes plus the owner's own session need more than four workers). */
    readonly config?: Partial<Config>;
  } = {},
): Promise<OutwardBed> {
  const repo = createGitBed();
  const bare = join(repo.dir, "remote.git");
  repo.git(repo.dir, "init", "-q", "--bare", "-b", "main", bare);
  repo.git(repo.root, "remote", "add", "origin", FORGE_URL);
  const stubDir = realpathSync(mkdtempSync(join(tmpdir(), "pap-stub-gh-")));
  const stub = writeStubForge(stubDir, answers);
  const t = await startTestDaemon(
    { steps: extra.steps ?? [{ text: "hi" }, { text: "hi" }, { text: "hi" }] },
    {
      config: { testGitProtocols: "file", ...extra.config },
      ...(extra.logger ? { deps: { logger: extra.logger } } : {}),
      workerEnv: { PATH: `${stubDir}:${process.env.PATH ?? ""}`, ...extraEnv },
    },
  );
  const userHome = join(t.root, "user");
  writeFileSync(
    join(userHome, ".gitconfig"),
    `[user]\n\tname = Owner\n\temail = owner@example.com\n[url "file://${bare}"]\n\tinsteadOf = ${FORGE_URL}\n`,
  );
  const cookie = await t.login();
  const owner = await t.connect(cookie);
  await t.confirmStepUp(cookie);
  const projectRoot = realpathSync(repo.root);
  const made = await owner.call("sessions.create", { cwd: projectRoot });
  if (!made.ok) throw new Error(`sessions.create failed: ${made.error.code}`);
  const opened = await owner.call("subscribe.lane", {});
  if (!opened.ok) throw new Error("subscribe.lane failed");
  const laneSub = (opened.result as { sub: string }).sub;
  const views = (laneId: string): LaneView[] =>
    owner.events
      .filter((frame: EventFrame) => frame.sub === laneSub)
      .map((frame) => frame.event as { kind: string; lane?: LaneView })
      .filter((event) => event.kind === "lane" && event.lane?.id === laneId)
      .map((event) => event.lane as LaneView);
  return {
    t,
    repo,
    bare,
    stub,
    owner,
    projectRoot,
    laneSub,
    views,
    async createLane(title = "Add thing") {
      const answer = await owner.call("lanes.create", {
        projectRoot,
        title,
        description: "do it",
        models: [null],
      });
      if (!answer.ok) throw new Error(`lanes.create failed: ${answer.error.code}`);
      const id = (answer.result as { laneIds: string[] }).laneIds[0] as string;
      await vi.waitFor(() => expect(views(id).at(-1)?.state).toBe("active"), { timeout: TIMEOUT });
      return views(id).at(-1) as LaneView;
    },
    async stop() {
      owner.close();
      await t.stop();
      repo.dispose();
      rmSync(stubDir, { recursive: true, force: true });
    },
  };
}

export const writeFile = (dir: string, name: string, text: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
};

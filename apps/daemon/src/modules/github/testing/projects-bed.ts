import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoxOpName, Caller } from "@pap/contracts";
import { vi } from "vitest";
import type { Clock } from "../../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../../kernel/db/migrate.ts";
import {
  createFakeBoxControl,
  createFakeBoxOps,
  type FakeBoxControl,
  type FakeBoxOps,
} from "../../../kernel/testing/fake-boxes.ts";
import { httpCaller } from "../../../kernel/http/caller.ts";
import { testCaller } from "../../../testing/caller.ts";
import { createProjectsModule, PROJECTS_MIGRATIONS, type ProjectsModule } from "../../projects/index.ts";
import {
  createGithubFeature,
  createGithubProjectsFeature,
  type GithubFeature,
  type GithubProjectRow,
  type GithubProjectsFeature,
  type GithubSessionsPort,
  type GithubProjectStore,
} from "../index.ts";
import { type GithubBed, OWNER, startGithubBed } from "./bed.ts";
import { NO_CLIENT_PATHS } from "../../../kernel/ws/client-path-gate.ts";

export const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItestkeyonlytestkeyonlytestkeyonlytest";

type Handlers = NonNullable<Parameters<typeof createFakeBoxOps>[0]>;

export interface ProjectsBed extends GithubBed {
  readonly caller: Caller;
  readonly projects: ProjectsModule;
  readonly feature: GithubProjectsFeature;
  readonly account: GithubFeature;
  readonly store: GithubProjectStore;
  /** The row of a project that must have one. */
  row(projectId: string): GithubProjectRow;
  readonly control: FakeBoxControl;
  readonly ops: FakeBoxOps;
  /** The delays the fork wait asked for (its `sleep` returns at once). */
  readonly sleeps: number[];
  /** The stop `bind` returned. */
  stopDelivery(): void;
  readonly audit: Array<{ reason: string; ownerId: string | null }>;
  /** The names of the ops sent to boxes, in order. */
  opNames(): BoxOpName[];
  /** What was asked of the sessions port, in order; `sessionIds` are the ones `sessionIdsIn` answers. */
  readonly sessionCalls: Array<{
    call: "create" | "prompt" | "markTainted";
    sessionId?: string;
    text?: string;
    cwd?: string;
  }>;
  readonly sessionIds: string[];
  /** The newest project of the owner. */
  create(name?: string): string;
}

/** The GitHub core, a real projects module on a migrated database, fake box control and ops, and the B3 feature bound to them. */
export async function startProjectsBed(handlers: Handlers = {}): Promise<ProjectsBed> {
  const bed = await startGithubBed();
  const dir = mkdtempSync(join(tmpdir(), "pap-github-projects-"));
  const db = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, PROJECTS_MIGRATIONS],
    clock: bed.clock,
    logger: bed.logger,
  }).db;
  const audit: ProjectsBed["audit"] = [];
  const auditPort = { append: (line: { reason: string; ownerId: string | null }) => void audit.push(line) };
  let counter = 0;
  const projects = createProjectsModule({
    isMember: () => false,
    db,
    clock: bed.clock,
    logger: bed.logger,
    audit: auditPort,
    newId: () => `${String(++counter).padStart(8, "a")}-0000-4000-8000-000000000000`,
  });
  const control = createFakeBoxControl();
  const ops = createFakeBoxOps({
    "fs.list": () => ({ entries: [], truncated: false }),
    "github.token": () => ({ ok: true as const }),
    "github.identity": () => ({ publicKey: PUBLIC_KEY }),
    "git.clone": () => ({ branch: "main" }),
    "git.link": () => ({ ok: true as const }),
    "git.unlink": () => ({ ok: true as const }),
    "github.forgetKey": () => ({ ok: true as const }),
    ...handlers,
  });
  projects.bindBoxes({
    control,
    ops,
    sessions: { count: () => 0, removeProject: async () => ({ sessions: 0 }) },
    automation: { count: () => 0, removeProject: async () => ({ triggers: 0 }) },
    requireStepUp: () => {},
  });
  const account = createGithubFeature(bed.core, {
    audit: auditPort,
    clock: bed.clock,
    logger: bed.logger,
    httpCaller: httpCaller(() => null, NO_CLIENT_PATHS),
    allowedOrigins: new Set(["http://pap.test"]),
    userIds: () => [],
    hostLabel: "host",
  });
  const sessionCalls: ProjectsBed["sessionCalls"] = [];
  const sessionIds: string[] = [];
  const sessions: GithubSessionsPort = {
    create: async (_caller, cwd) => {
      sessionCalls.push({ call: "create", cwd });
      return { sessionId: "new-session" };
    },
    prompt: async (_caller, sessionId, text) => void sessionCalls.push({ call: "prompt", sessionId, text }),
    sessionIdsIn: () => sessionIds,
    markTainted: (_owner, sessionId) => void sessionCalls.push({ call: "markTainted", sessionId }),
  };
  const sleeps: number[] = [];
  const clock: Clock = { ...bed.clock, sleep: async (ms) => void sleeps.push(ms) };
  const feature = createGithubProjectsFeature(bed.core, {
    db,
    audit: auditPort,
    clock,
    logger: bed.logger,
    projects,
    permissionMissing: () => account.service.setPermissionMissing(true),
    sessions,
  });
  const stopDelivery = feature.bind({ control, ops });
  const stop = feature.start();

  const response = await fetch(`${bed.fake.origin}/login/oauth/access_token`, {
    method: "POST",
    body: JSON.stringify({ code: "bed" }),
  });
  bed.core.userTokens.store(
    OWNER,
    (await response.json()) as Parameters<typeof bed.core.userTokens.store>[1],
  );
  bed.fake.state.addRepo("octo/hello");

  const caller = testCaller({ userId: OWNER });
  return Object.assign(Object.create(bed) as GithubBed, bed, {
    caller,
    projects,
    feature,
    account,
    store: feature.store,
    row: (id: string) => {
      const row = feature.store.get(id);
      if (!row) throw new Error("no project_github row");
      return row;
    },
    control,
    ops,
    sleeps,
    sessionCalls,
    sessionIds,
    stopDelivery,
    audit,
    opNames: () => ops.all.map((call) => call.op.name),
    create: (name = "hello") => projects.create(caller, name).id,
    close: async () => {
      stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
      await bed.close();
    },
  }) as ProjectsBed;
}

/** Waits (without a sleep) until `check` holds: the delivery runs behind the box phase, on real sockets to the fake GitHub. */
export const eventually = (check: () => void): Promise<void> =>
  vi.waitFor(check, { timeout: 5000, interval: 5 });

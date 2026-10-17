import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { composeM11, M11_MIGRATION_SOURCES } from "../compose-m11.ts";
import { createFakeClock } from "../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../kernel/db/migrate.ts";
import { silentLogger } from "../kernel/logger.ts";
import { createInbox, INBOX_MIGRATIONS } from "../modules/inbox/index.ts";
import { RUNS_MIGRATIONS } from "../modules/runs/index.ts";

const dirs: string[] = [];
/** A proxy that never booted: unusable, nothing opens. */
const UNUSABLE_EGRESS = {
  ready: async () => {},
  status: () => ({ usable: false, python: null, reason: "no_python" }),
  forwarderPath: null,
  openCommand: async () => ({ reason: "unavailable" }),
  closeCommand: async () => ({ hosts: [], truncated: true, up: 0, down: 0 }),
  dropSession: async () => {},
  recheck: async () => {},
};
/** A spy that takes anything: typed here, so that the inferred type of `parts` can be named in a declaration. */
const spy = () => vi.fn<(...args: unknown[]) => unknown>();
/** Removes the folders the parts made; the test files call it from `afterEach`. */
export function disposeParts(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** `composeM11` over a real database (the M11 and Inbox tables) and fakes for the other modules. */
export function parts(
  options: { readOnly?: boolean; busy?: boolean; beforeBoot?(dir: string): void; realEgress?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "pap-compose-m11-"));
  dirs.push(dir);
  const clock = createFakeClock();
  const db = migrate({
    dbPath: join(dir, "state.db"),
    backupsDir: join(dir, "backups"),
    sources: [KERNEL_MIGRATIONS, RUNS_MIGRATIONS, INBOX_MIGRATIONS, ...M11_MIGRATION_SOURCES],
    clock,
    logger: silentLogger,
  }).db;
  const automation = {
    state: vi.fn(() => ({ archived: false, running: false, needsInput: false })),
    promptPending: vi.fn(() => false),
    archive: spy(),
    abort: vi.fn(async () => {}),
    onAttention: vi.fn(() => () => {}),
    lastActivityAt: vi.fn(() => null),
  };
  const hub = { publish: spy(), registerSnapshot: spy() };
  const runEnds: Array<(event: unknown) => void> = [];
  const runs = {
    onRunStart: vi.fn(() => () => {}),
    onRunEnd: vi.fn((listener: (event: unknown) => void) => (runEnds.push(listener), () => {})),
  };
  const sessions = {
    setAgentPorts: spy(),
    kindOf: vi.fn(() => ({ ownerId: "u1", type: "agent-thread", tainted: false, agentId: "atlas-0001" })),
    agentSessions: {
      createAgentSession: vi.fn(async () => ({ sessionId: "t1" })),
      threadState: vi.fn(() => ({ running: false, needsInput: false, starting: false, archived: false })),
      applyLive: spy(),
      sendToAgent: vi.fn(() => 1),
      sandboxed: vi.fn(() => true),
      activeTools: vi.fn((): { tools: readonly string[]; truncated: boolean } | null => null),
    },
    hostGrants: { of: vi.fn((): string[] => []), has: vi.fn(() => false) },
    approvedCalls: { take: vi.fn(() => false) },
    releaseIdle: vi.fn(() => "released"),
    automation,
  };
  const laneOf = vi.fn((cwd: string) => (cwd === "/lane" ? { ownerId: "u1" } : null));
  const agentTasks = {
    runningRequester: vi.fn((): string | null => null),
    delegationsSince: vi.fn(() => 0),
    queuedDelegationsTo: vi.fn(() => 0),
    reminders: vi.fn(() => ({ pending: 0, created: 0 })),
    overBudget: vi.fn(() => false),
    delegate: vi.fn(() => ({ taskId: "delegated-1" })),
    remind: vi.fn(() => ({ taskId: "reminder-1" })),
  };
  const automationModule = {
    agentTasks,
    bindAgents: spy(),
    agentLink: {
      busy: vi.fn(() => options.busy ?? false),
      deleteTriggersOf: spy(),
      cancelQueuedOf: vi.fn(async () => {}),
      cancelAllOf: vi.fn(async () => 0),
      rotateSecretsOf: vi.fn(() => ({
        secrets: [] as Array<{ triggerId: string; name: string; secret: string }>,
        failed: [] as string[],
      })),
      queueTask: vi.fn(() => ({ taskId: "queued-1" })),
      statusOf: vi.fn(() => ({ tasks: [], triggers: [] })),
    },
  };
  const settings = { port: { automation: vi.fn(() => ({ timezone: "UTC", quietHours: null })) } };
  // The real Inbox: the delegation result's reply item and an agent's delete are read back from its table.
  const inbox = createInbox({
    db,
    clock,
    logger: silentLogger,
    hub,
    events: { on: () => () => {} },
    tasks: { find: () => null },
    readOnly: false,
  });
  // The Inbox's agent items, spied through to the real ones: the requests' tests read the calls, the delegation tests the rows.
  const agentItems = {
    upsertAgentItem: vi.spyOn(inbox.agentItems, "upsertAgentItem"),
    resolveRef: vi.spyOn(inbox.agentItems, "resolveRef"),
  };
  options.beforeBoot?.(dir);
  const m11 = composeM11(
    {
      db,
      config: { home: dir, bwrapOverride: "/nonexistent/pap-bwrap" },
      clock,
      logger: silentLogger,
      readOnly: options.readOnly ?? false,
      hub,
    },
    {
      runs,
      sessions,
      audit: { port: { append: spy(), reserve: () => true } },
      lanes: { paths: { laneOf } },
      git: { run: spy() },
      automationModule,
      inbox,
      settings,
      // The real proxy would probe python3 and write under the home for every composition: the tests that do not need it get a stand-in.
      ...(options.realEgress ? {} : { egress: UNUSABLE_EGRESS }),
    } as never,
  );
  return {
    sessions,
    m11,
    laneOf,
    db,
    automation,
    automationModule,
    agentTasks,
    inbox,
    agentItems,
    home: dir,
    hub,
    runs,
    runEnds,
    clock,
    settings,
  };
}

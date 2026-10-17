import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput, type Caller } from "@pap/contracts";
import { createFakeClock } from "../../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, type MigrationSource, migrate } from "../../../kernel/db/migrate.ts";
import { createGitRunner, GitError, type GitRunner } from "../../../kernel/git/runner.ts";
import { createLogger } from "../../../kernel/logger.ts";
import { testCaller } from "../../../testing/caller.ts";
import { AUDIT_MIGRATIONS, createAuditModule } from "../../audit/index.ts";
import { requireStepUp } from "../../auth/index.ts";
import { AGENTS_MIGRATIONS, createAgentGuard, createAgents } from "../index.ts";

/** A real database through `migrate`, a fake clock, a temporary `$PAP_HOME` and the real git runner behind a spy. */
export function createAgentsBed(options: { startAt?: number; migrations?: readonly MigrationSource[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pap-agents-"));
  const clock = createFakeClock(options.startAt ?? 1_700_000_000_000);
  const logs: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: "debug",
    clock,
    write: (line) => void logs.push(JSON.parse(line) as Record<string, unknown>),
  });
  const db = migrate({
    dbPath: join(dir, "state.db"),
    backupsDir: join(dir, "backups"),
    sources: [KERNEL_MIGRATIONS, AUDIT_MIGRATIONS, AGENTS_MIGRATIONS, ...(options.migrations ?? [])],
    clock,
    logger,
  }).db;
  logs.length = 0;
  const papHome = join(dir, "pap");
  const userHome = join(dir, "user");
  for (const path of [papHome, userHome]) mkdirSync(path, { mode: 0o700 });
  const audit = createAuditModule({ db, clock, logger });
  const real = createGitRunner({ env: { PATH: process.env.PATH, HOME: userHome }, logger });
  const calls: Array<{ root: string; args: string[] }> = [];
  const failing = { subcommand: null as string | null };
  const git: GitRunner = {
    async run(root, args, runOptions) {
      calls.push({ root, args: [...args] });
      if (args[0] === failing.subcommand) throw new GitError("failed");
      return real.run(root, args, runOptions);
    },
  };
  let next = 0;
  const guard = createAgentGuard();
  const agents = createAgents({
    guard,
    db,
    clock,
    logger,
    audit: audit.port,
    git,
    papHome,
    requireStepUp,
    randomHex: () => (next++).toString(16).padStart(4, "0"),
  });
  return {
    dir,
    db,
    clock,
    logs,
    papHome,
    agents,
    guard,
    audit: audit.port,
    calls,
    failing,
    /** The owner `u1` in a browser session that confirmed the password a moment ago. */
    owner: (overrides: Partial<Caller> = {}): Caller =>
      testCaller({ stepUpUntil: clock.now() + 60_000, ...overrides }),
    /** The owner `u1` in a browser session that has not confirmed the password. */
    unconfirmed: (overrides: Partial<Caller> = {}): Caller => testCaller(overrides),
    auditRows: (): Array<{ actor: string; kind: string; decision: string; reason: string; detail: string }> =>
      db.all("SELECT actor, kind, decision, reason, detail FROM audit ORDER BY id"),
    dispose() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export type AgentsBed = ReturnType<typeof createAgentsBed>;

/** The input an owner's form sends, decoded the way the dispatcher decodes it (defaults filled in). */
export const agentInput = (extra: object = {}): AgentInput => AgentInput.parse({ name: "Atlas", ...extra });

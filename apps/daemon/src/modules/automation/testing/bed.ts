import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Caller, TOKEN_PERMISSIONS, TriggerInput } from "@pap/contracts";
import type { ProjectBoxSource } from "../../../kernel/boxes.ts";
import { createFakeClock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../../kernel/db/migrate.ts";
import { newId } from "../../../kernel/ids.ts";
import { createLogger } from "../../../kernel/logger.ts";
import { testCaller } from "../../../testing/caller.ts";
import { AUDIT_MIGRATIONS, createAuditModule } from "../../audit/index.ts";
import { requireStepUp } from "../../auth/index.ts";
import { createProjectsModule, PROJECTS_MIGRATIONS } from "../../projects/index.ts";
import { RUNS_MIGRATIONS } from "../../runs/index.ts";
import { type AgentBinding, AUTOMATION_MIGRATIONS, createTriggers, type TriggerChanged } from "../index.ts";

/** A real database through `migrate`, a fake clock, a temporary `$PAP_HOME` and Pi folder, and the triggers service over them. */
export function createAutomationBed(
  options: { startAt?: number; agents?: AgentBinding; boxes?: () => ProjectBoxSource | undefined } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "pap-automation-"));
  const clock = createFakeClock(options.startAt ?? Date.now());
  const logs: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: "debug",
    clock,
    write: (line) => void logs.push(JSON.parse(line) as Record<string, unknown>),
  });
  const db: Db = migrate({
    dbPath: join(dir, "state.db"),
    backupsDir: join(dir, "backups"),
    sources: [
      KERNEL_MIGRATIONS,
      AUDIT_MIGRATIONS,
      PROJECTS_MIGRATIONS,
      AUTOMATION_MIGRATIONS,
      RUNS_MIGRATIONS,
    ],
    clock,
    logger,
  }).db;
  logs.length = 0;
  const home = join(dir, "home");
  const piAgentDir = join(dir, "pi-agent");
  const folder = join(dir, "work");
  for (const path of [home, piAgentDir, folder]) mkdirSync(path, { recursive: true });
  const audit = createAuditModule({ db, clock, logger });
  const projects = createProjectsModule({ db, clock, logger, newId });
  const changeListeners: Array<(change: TriggerChanged) => void> = [];
  const triggers = createTriggers({
    ...(options.agents ? { agents: options.agents } : {}),
    onChange: (change) => changeListeners.forEach((listener) => listener(change)),
    db,
    clock,
    logger,
    audit: audit.port,
    projects: projects.port,
    scopeOf: (cwd) => cwd,
    ...(options.boxes ? { boxes: options.boxes } : {}),
    config: { home, piAgentDir, publicOrigin: "https://pap.example" },
    requireStepUp,
  });
  const secretsDir = join(home, "secrets", "triggers");
  return {
    dir,
    db,
    clock,
    logger,
    logs,
    home,
    piAgentDir,
    folder,
    secretsDir,
    audit,
    projects,
    triggers,
    /** What the composition wires to the tasks stream: every trigger saved, switched, rotated or deleted. */
    onTriggerChange: (listener: (change: TriggerChanged) => void) => void changeListeners.push(listener),
    /** The owner `u1` in a browser session that confirmed the password a moment ago. */
    owner: (overrides: Partial<Caller> = {}): Caller =>
      testCaller({ stepUpUntil: clock.now() + 60_000, ...overrides }),
    /** The owner `u1` in a browser session that has not confirmed the password. */
    unconfirmed: (overrides: Partial<Caller> = {}): Caller => testCaller(overrides),
    /** An API token of `u1`: it holds what a token may hold, never `automation:admin`. */
    token: (): Caller =>
      testCaller({ kind: "token", credentialId: "tok1", permissions: new Set(TOKEN_PERMISSIONS) }),
    auditRows: (): Array<{
      actor: string;
      actor_id: string | null;
      kind: string;
      decision: string;
      reason: string;
      detail: string;
    }> => db.all("SELECT actor, actor_id, kind, decision, reason, detail FROM audit ORDER BY id"),
    dispose() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export type AutomationBed = ReturnType<typeof createAutomationBed>;

/** What the editor sends, decoded the way the dispatcher decodes it (defaults filled in). */
export const parsedInput = (raw: unknown): TriggerInput => TriggerInput.parse(raw);

export const manualInput = (cwd: string, name = "Nightly check"): TriggerInput =>
  parsedInput({
    name,
    source: { type: "manual" },
    execution: { cwd },
    prompt: "Look at the repository and report.",
  });

export const webhookInput = (
  cwd: string,
  auth: "secret" | "hmac" = "secret",
  name = "Alert hook",
): TriggerInput =>
  parsedInput({
    name,
    source: { type: "webhook", auth },
    execution: { cwd },
    prompt: "An alert fired: {{payload}}",
  });

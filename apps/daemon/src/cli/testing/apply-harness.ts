import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Readiness } from "../service/readiness.ts";
import type { ApplyDeps } from "../update/apply.ts";
import { readPending } from "../update/pending.ts";
import { readCurrent } from "../update/releases.ts";

export const URL_READY: Readiness = { kind: "url", url: "http://127.0.0.1:7777/setup" };

export interface Ctl {
  /** Answers of `listening`, one per call; the last repeats. A function throws or answers by call number. */
  listening: (Readiness | "throw")[];
  healthz: boolean[];
  states: (string | null)[];
  restarts: (number | null)[];
  /** The new release runs a migration and writes a row when it is started. */
  migrate: boolean;
  /** The new release writes a row (no migration). */
  writeRow: boolean;
  stopHook?: (n: number) => void;
  holdFails?: boolean;
}

export interface Harness {
  root: string;
  app: string;
  home: string;
  /** systemd calls only, in order. */
  calls: string[];
  /** systemd calls plus `hold` and `release`. */
  events: string[];
  /** `pending.step` at each systemd call and each `listening` call. */
  steps: (string | null)[];
  ctl: Ctl;
  deps: ApplyDeps;
  rows(): string[];
  ids(): string[];
  cleanup(): void;
}

export function makeRelease(app: string, id: string): void {
  const dir = join(app, "releases", id);
  mkdirSync(join(dir, "node", "bin"), { recursive: true });
  mkdirSync(join(dir, "app", "apps", "daemon", "dist"), { recursive: true });
  writeFileSync(join(dir, "node", "bin", "node"), "#!/bin/sh\n");
  chmodSync(join(dir, "node", "bin", "node"), 0o755);
  writeFileSync(join(dir, "app", "apps", "daemon", "dist", "main.js"), "");
}

function queue<T>(items: T[], index: number): T {
  return items[Math.min(index, items.length - 1)] as T;
}

/** Releases `old` (current) and `new`, a database with migration `001` and one row `a`, and fakes that record every call. */
export function harness(options: { withDb?: boolean; ctl?: Partial<Ctl> } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "pap-apply-"));
  const app = join(root, "app");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  makeRelease(app, "old");
  makeRelease(app, "new");
  symlinkSync("releases/old", join(app, "current"));
  const dbPath = join(home, "state.db");
  if (options.withDb !== false) {
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE schema_migrations (id TEXT PRIMARY KEY) STRICT; CREATE TABLE note (body TEXT) STRICT",
    );
    db.exec("INSERT INTO schema_migrations (id) VALUES ('001'); INSERT INTO note (body) VALUES ('a')");
    db.close();
  }
  const ctl: Ctl = {
    listening: [URL_READY],
    healthz: [true],
    states: ["active"],
    restarts: [0],
    migrate: false,
    writeRow: false,
    ...options.ctl,
  };
  const calls: string[] = [];
  const events: string[] = [];
  const steps: (string | null)[] = [];
  const counters = { stop: 0, listening: 0, healthz: 0, state: 0, restartCount: 0 };
  const step = (): string | null => {
    const pending = readPending(home);
    return pending === null || pending === "damaged" ? null : pending.step;
  };
  const record = (name: string): void => {
    calls.push(name);
    events.push(name);
    steps.push(step());
  };
  let held = false;
  const withDb = (run: (db: DatabaseSync) => void): void => {
    const db = new DatabaseSync(dbPath);
    try {
      run(db);
    } finally {
      db.close();
    }
  };
  const deps: ApplyDeps = {
    app,
    home,
    knownIds: new Set(["001", "002"]),
    systemd: {
      async stop() {
        record("stop");
        ctl.stopHook?.(counters.stop++);
      },
      async restart() {
        record("restart");
        if (readCurrent(app) === "new") {
          if (ctl.migrate)
            withDb((db) =>
              db.exec(
                "INSERT INTO schema_migrations (id) VALUES ('002'); INSERT INTO note (body) VALUES ('m')",
              ),
            );
          if (ctl.writeRow) withDb((db) => db.exec("INSERT INTO note (body) VALUES ('w')"));
        }
      },
      async resetFailed() {
        record("reset-failed");
      },
      async activeState() {
        return queue(ctl.states, counters.state++);
      },
      async restartCount() {
        return queue(ctl.restarts, counters.restartCount++);
      },
    },
    async listening() {
      steps.push(step());
      const answer = queue(ctl.listening, counters.listening++);
      if (answer === "throw") throw new Error("journal exploded");
      return answer;
    },
    async healthz() {
      return queue(ctl.healthz, counters.healthz++);
    },
    async sleep() {},
    now: () => new Date("2026-10-17T10:00:00.000Z"),
    freeMb: () => 100_000,
    holdHome() {
      if (ctl.holdFails === true || held) throw new Error("busy");
      held = true;
      events.push("hold");
      return () => {
        held = false;
        events.push("release");
      };
    },
    deadlineMs: 120_000,
    settleMs: 10_000,
    unit: "pap.service",
  };
  const read = <T>(sql: string, key: string): T[] => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return (db.prepare(sql).all() as Record<string, T>[]).map((row) => row[key] as T);
    } finally {
      db.close();
    }
  };
  return {
    root,
    app,
    home,
    calls,
    events,
    steps,
    ctl,
    deps,
    rows: () => read<string>("SELECT body FROM note ORDER BY rowid", "body"),
    ids: () => read<string>("SELECT id FROM schema_migrations ORDER BY id", "id"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

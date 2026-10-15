import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../../../kernel/clock.ts";
import type { Logger } from "../../../kernel/logger.ts";
import {
  createScriptRunner,
  createScriptStore,
  type GroupOps,
  type ProcProbe,
  type ScriptChild,
  type ScriptExit,
  type ScriptRunnerDeps,
  type ScriptSpec,
} from "../index.ts";
import type { Db } from "../../../kernel/db/database.ts";

export interface FakeChild extends ScriptChild {
  readonly spec: ScriptSpec;
  readonly cwd: string;
  emit(text: string | Buffer): void;
  end(exit: ScriptExit): void;
}

/** Fake processes and group signals: no real pid is ever signalled by a unit test. */
export function createFakes(onSpawn?: (child: FakeChild) => void) {
  const children: FakeChild[] = [];
  const signals: Array<{ pid: number; signal: string }> = [];
  const tracked = new Set<number>();
  let nextPid = 40_000;
  const spawn = (spec: ScriptSpec, cwd: string): FakeChild => {
    const listeners: Array<(chunk: Buffer) => void> = [];
    let settle: (exit: ScriptExit) => void = () => undefined;
    const exited = new Promise<ScriptExit>((resolve) => (settle = resolve));
    const child: FakeChild = {
      pid: nextPid++,
      spec,
      cwd,
      exited,
      onOutput: (listener) => void listeners.push(listener),
      emit: (text) => {
        for (const listener of listeners) listener(Buffer.from(text));
      },
      end: (exit) => settle(exit),
    };
    children.push(child);
    onSpawn?.(child);
    return child;
  };
  const groups: GroupOps = {
    track: (pid) => void tracked.add(pid),
    release: (pid) => void tracked.delete(pid),
    signal: (pid, signal) => {
      signals.push({ pid, signal });
      return true;
    },
  };
  const probe: ProcProbe & { boot: string | null; starts: Map<number, string> } = {
    boot: "boot-1",
    starts: new Map(),
    bootId() {
      return this.boot;
    },
    startOf(pid) {
      return this.starts.get(pid) ?? "1000";
    },
  };
  const child = (at: number): FakeChild => {
    const found = children[at];
    if (!found) throw new Error(`no script child ${at}`);
    return found;
  };
  return { children, child, signals, tracked, spawn, groups, probe };
}

export function tempHome(): { dir: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), "pap-scripts-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

export function runnerOf(input: {
  db: Db;
  clock: Clock;
  logger: Logger;
  home: string;
  fakes: ReturnType<typeof createFakes>;
  approved?: ScriptRunnerDeps["approved"];
  extra?: Partial<ScriptRunnerDeps>;
}) {
  return createScriptRunner({
    store: createScriptStore(input.db),
    clock: input.clock,
    logger: input.logger,
    home: input.home,
    env: { HOME: "/home/o", PATH: "/usr/bin:/bin", SSH_AUTH_SOCK: "/agent" },
    umask: 0o022,
    scopes: { next: () => null },
    approved: input.approved ?? (async () => ({ ok: true, text: "echo hi" })),
    spawn: input.fakes.spawn,
    probe: input.fakes.probe,
    groups: input.fakes.groups,
    readOnly: false,
    ...input.extra,
  });
}

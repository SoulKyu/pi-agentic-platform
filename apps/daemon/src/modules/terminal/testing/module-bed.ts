import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller, HandlerContext, ParamsOf, TerminalStreamEvent } from "@pap/contracts";
import { vi } from "vitest";
import type { BoundaryConfig } from "../../../kernel/fs/boundary.ts";
import { createFakeClock } from "../../../kernel/clock.ts";
import { createStreamHub } from "../../../kernel/ws/stream-hub.ts";
import { captureLogger } from "../../../testing/capture-logger.ts";
import { testCaller } from "../../../testing/caller.ts";
import { createTerminalModule } from "../index.ts";
import { createFakeNodePty, type FakeChild } from "./fake-node-pty.ts";
import { createFakeConnection } from "./fake-stream.ts";

export const REQUEST_ID = "r".repeat(16);

/**
 * The terminal module over a fake `node-pty`, a fake clock and a real stream hub, with a project folder, a file, a
 * `$PAP_HOME` and an agent folder in a temporary directory. `kill` ends the fake shell like the kernel's ladder would.
 */
export function makeModuleBed(options: { max?: number; pty?: boolean; scope?: boolean } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pap-term-mod-")));
  const project = join(base, "project");
  const papHome = join(base, "pap-home");
  const agentDir = join(base, "agent");
  for (const dir of [project, join(project, "sub"), papHome, agentDir]) mkdirSync(dir);
  writeFileSync(join(project, "file.txt"), "x");
  const boundary: BoundaryConfig = {
    papHome: [papHome],
    agentDir: [agentDir],
    home: [join(base, "user")],
    papHomeOpen: [],
    runtimeDirs: [],
  };
  /** One entry per working folder the module judged. */
  const judged: string[] = [];
  const clock = createFakeClock();
  const hub = createStreamHub("epoch", clock);
  const { logger, lines } = captureLogger();
  const fake = createFakeNodePty();
  const reap = vi.fn<(exit: unknown) => Promise<{ oomKilled: boolean }>>(async () => ({ oomKilled: false }));
  const scopeNext = vi.fn(() =>
    options.scope
      ? { unit: "unit", launch: { command: "systemd-run", args: ["--scope"], env: {} }, reap }
      : null,
  );
  const kill = vi.fn(async (target: { pid: number }) => {
    fake.children.find((child) => child.pid === target.pid)?.end(0, 1);
  });
  const module = createTerminalModule({
    roots: (ownerId) => {
      judged.push(ownerId);
      return ownerId === "u1" || ownerId === "u2" ? [project] : [];
    },
    boundary,
    hub,
    clock,
    logger,
    env: { PATH: "/usr/bin", SHELL: "/bin/sh", PAP_HOME: "/secret", TOKEN: "t" },
    scopes: { next: scopeNext },
    workerUmask: 0o027,
    maxTerminals: options.max ?? 8,
    minFreeMemMb: 0,
    loadPty: () => (options.pty === false ? null : fake.pty),
    freeMemMb: () => 10_000,
    kill,
    alive: () => true,
  });
  const connection = createFakeConnection();
  const ctxOf = (caller: Caller = testCaller(), connectionId = "c1", withBinary = true): HandlerContext => ({
    caller,
    connectionId,
    openSubscription: (stream, key, after) => {
      void stream;
      void key;
      void after;
      return "s1";
    },
    closeSubscription: () => {},
    ...(withBinary ? { binary: connection } : {}),
  });
  const create = async (
    params: Partial<ParamsOf<"terminal.create">> = {},
    ctx: HandlerContext = ctxOf(),
  ): Promise<string> => {
    const result = await module.rpc["terminal.create"](
      { requestId: REQUEST_ID, cwd: project, cols: 80, rows: 24, ...params },
      ctx,
    );
    return result.terminalId;
  };
  /** What a new subscriber of the owner's `terminal` stream receives first. */
  const listed = (ownerId = "u1"): TerminalStreamEvent => {
    const frames: unknown[] = [];
    hub.open({
      connectionId: `list-${ownerId}-${Math.random()}`,
      sub: "s",
      stream: "terminal",
      key: ownerId,
      after: undefined,
      send: (frame) => void frames.push(frame),
    });
    return (frames[0] as { event: TerminalStreamEvent }).event;
  };
  const child = (index = 0): FakeChild => {
    const found = fake.children[index];
    if (!found) throw new Error("no shell was spawned");
    return found;
  };
  return {
    module,
    rpc: module.rpc,
    fake,
    kill,
    scopeNext,
    reap,
    judged,
    hub,
    clock,
    lines,
    connection,
    project,
    papHome,
    agentDir,
    base,
    ctxOf,
    create,
    listed,
    child,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

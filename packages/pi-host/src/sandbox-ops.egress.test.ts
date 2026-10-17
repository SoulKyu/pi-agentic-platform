import type { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  bwrapArgv,
  EGRESS_SOCKET,
  type EgressHost,
  type EgressReport,
  type SandboxSpec,
} from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefusalAdvice } from "./egress-line.ts";
import { sandboxedShell, type ShellEgress, toolCall } from "./sandbox-ops.ts";

const SOCKET = "/run/user/1000/pap/ab12cd/egress/0/1.s";
const NO_PROXY_LINE = "[pap] The egress proxy was not available for this command; it ran without network.";

interface Spawned {
  readonly file: string;
  readonly argv: readonly string[];
  readonly child: EventEmitter & { pid: number; stdout: PassThrough; stderr: PassThrough };
}

let root: string;
let spec: SandboxSpec;
let spawned: Spawned[];
let kill: ReturnType<typeof vi.spyOn>;

const fakeSpawn = ((file: string, argv: readonly string[]) => {
  const child = Object.assign(new EventEmitter(), {
    pid: 424_242,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  spawned.push({ file, argv, child });
  return child;
}) as unknown as typeof nodeSpawn;
const timers = { setTimeout: () => ({}), clearTimeout: () => {} };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const hostEntry = (host: string, over: Partial<EgressHost> = {}): EgressHost => ({
  host,
  port: 443,
  kind: "connect",
  verdict: "refused",
  reason: "not_listed",
  ...over,
});
const reportOf = (id: string, hosts: EgressHost[] = []): EgressReport => ({
  type: "egress_report",
  id,
  hosts,
  truncated: false,
  up: 0,
  down: 0,
});

interface Port extends ShellEgress {
  readonly kept: Array<[string, EgressReport | null]>;
  readonly closed: string[];
  readonly opened: number;
}
function port(
  answers: Array<{ id: string; socket: string } | null>,
  reports: Record<string, EgressReport | null> = {},
): Port {
  let opened = 0;
  const kept: Array<[string, EgressReport | null]> = [];
  const closed: string[] = [];
  return {
    kept,
    closed,
    get opened() {
      return opened;
    },
    open: async () => answers[opened++] ?? null,
    close: async (id) => (closed.push(id), reports[id] ?? reportOf(id)),
    keep: (toolCallId, report) => void kept.push([toolCallId, report]),
  };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-sandbox-egress-")));
  for (const dir of ["home/.pap/agents/atlas", "home/.pap/agents/.runs/atlas/t1"])
    mkdirSync(join(root, dir), { recursive: true });
  const home = join(root, "home/.pap/agents/atlas");
  spec = {
    bwrap: "/usr/bin/bwrap",
    view: "host",
    home,
    writable: home,
    hide: [join(root, "home")],
    network: true,
    egress: { python: "/usr/bin/python3", forwarder: "/srv/pap/egress/fwd.py" },
  };
  spawned = [];
  kill = vi.spyOn(process, "kill").mockImplementation(() => true);
});
afterEach(() => {
  kill.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

function exec(
  egress: ShellEgress | undefined,
  toolCallId: string | undefined,
  command = "curl https://allowed.test",
  advice?: () => RefusalAdvice,
) {
  const out: string[] = [];
  const ops = sandboxedShell(spec, () => ({ PATH: "/usr/bin" }), {
    timers,
    spawn: fakeSpawn,
    ...(egress ? { egress } : {}),
    ...(advice ? { advice } : {}),
  });
  const start = () => ops.exec(command, "/", { onData: (data) => out.push(data.toString()) });
  const done = toolCallId === undefined ? start() : toolCall.run(toolCallId, start);
  return { done, out };
}
/** Lets the call reach its spawn, then ends the child (the newest one unless an index is given). */
const finish = async (index?: number, data = "") => {
  await flush();
  const child = spawned[index ?? spawned.length - 1]?.child;
  if (data) child?.stdout.emit("data", Buffer.from(data));
  child?.emit("close", 0, null);
};

describe("a networked command (M11R232, worker half)", () => {
  it("binds the socket the daemon gave and closes the command after the child's close", async () => {
    const egress = port([{ id: "c1", socket: SOCKET }]);
    const { done } = exec(egress, "t1");
    await flush();
    expect(spawned[0]?.argv).toEqual(bwrapArgv(spec, "curl https://allowed.test", SOCKET));
    expect(egress.closed).toEqual([]);
    await finish();
    await expect(done).resolves.toEqual({ exitCode: 0 });
    expect(egress.closed).toEqual(["c1"]);
  });

  it("stores the report under the tool call id the AsyncLocalStorage carries", async () => {
    const mine = reportOf("c1", [hostEntry("allowed.test", { verdict: "allowed", reason: undefined })]);
    const egress = port([{ id: "c1", socket: SOCKET }], { c1: mine });
    const { done } = exec(egress, "call-7");
    await finish();
    await done;
    expect(egress.kept).toEqual([["call-7", mine]]);
  });

  it("keeps two concurrent calls' reports apart, whichever closes first", async () => {
    const first = reportOf("c1", [hostEntry("one.test", { verdict: "allowed", reason: undefined })]);
    const second = reportOf("c2", [hostEntry("two.test", { verdict: "allowed", reason: undefined })]);
    const egress = port(
      [
        { id: "c1", socket: SOCKET },
        { id: "c2", socket: `${SOCKET}.2` },
      ],
      { c1: first, c2: second },
    );
    const a = exec(egress, "call-a");
    const b = exec(egress, "call-b");
    await flush();
    expect(spawned.map((entry) => entry.argv)).toEqual([
      bwrapArgv(spec, "curl https://allowed.test", SOCKET),
      bwrapArgv(spec, "curl https://allowed.test", `${SOCKET}.2`),
    ]);
    await finish(1);
    await b.done;
    await finish(0);
    await a.done;
    expect(egress.kept).toEqual([
      ["call-b", second],
      ["call-a", first],
    ]);
  });

  it("runs without network and says so when the proxy gave no socket", async () => {
    const egress = port([null]);
    const { done, out } = exec(egress, "t1");
    await flush();
    expect(spawned[0]?.argv).toEqual(
      bwrapArgv({ ...spec, network: false, egress: null }, "curl https://allowed.test"),
    );
    expect(spawned[0]?.argv).not.toContain(EGRESS_SOCKET);
    await finish(0, "out\n");
    await done;
    expect(out.join("")).toBe(`out\n${NO_PROXY_LINE}\n`);
    expect(egress.closed).toEqual([]);
    expect(egress.kept).toEqual([]);
  });

  it("runs without network when no tool call id reaches it, or when there is no egress client", async () => {
    const without = exec(port([{ id: "c1", socket: SOCKET }]), undefined);
    await finish(0);
    await without.done;
    expect(spawned[0]?.argv).not.toContain(EGRESS_SOCKET);
    expect(without.out.join("")).toContain(NO_PROXY_LINE);
    const lone = exec(undefined, "t1");
    await finish(1);
    await lone.done;
    expect(spawned[1]?.argv).not.toContain(EGRESS_SOCKET);
  });

  it("does not ask the proxy for a network-off spec, whose argument list stays what it was", async () => {
    spec = { ...spec, network: false, egress: null };
    const egress = port([{ id: "c1", socket: SOCKET }]);
    const { done, out } = exec(egress, "t1");
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.argv).toEqual(bwrapArgv(spec, "curl https://allowed.test"));
    spawned[0]?.child.emit("close", 0, null);
    await done;
    expect(egress.opened).toBe(0);
    expect(out).toEqual([]);
  });

  it("still closes the command when it is aborted", async () => {
    const egress = port([{ id: "c1", socket: SOCKET }]);
    const controller = new AbortController();
    const ops = sandboxedShell(spec, () => ({}), { timers, spawn: fakeSpawn, egress });
    const done = toolCall.run("t1", () =>
      ops.exec("sleep 9", "/", { onData: () => {}, signal: controller.signal }),
    );
    await flush();
    controller.abort();
    spawned[0]?.child.emit("close", null, "SIGKILL");
    await expect(done).rejects.toThrow("aborted");
    expect(egress.closed).toEqual(["c1"]);
    expect(egress.kept).toHaveLength(1);
  });
});

describe("ids and settling (review of XS1)", () => {
  it("clips the tool call id the way the result hook looks it up (256 units)", async () => {
    const long = "t".repeat(300);
    const egress = port([{ id: "c1", socket: SOCKET }]);
    const { done } = exec(egress, long);
    await finish();
    await done;
    expect(egress.kept.map(([id]) => id)).toEqual(["t".repeat(256)]);
  });

  it("runs its closing step once when the child errors and then closes", async () => {
    const egress = port([{ id: "c1", socket: SOCKET }]);
    const { done } = exec(egress, "t1");
    await flush();
    spawned[0]?.child.emit("error", new Error("spawn failed"));
    spawned[0]?.child.emit("close", 1, null);
    await expect(done).rejects.toThrow("spawn failed");
    expect(egress.closed).toEqual(["c1"]);
    expect(egress.kept).toHaveLength(1);
  });
});

describe("a failing egress close", () => {
  it("is logged by class only and never leaves the call unsettled", async () => {
    const written: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => (written.push(String(chunk)), true));
    const broken: ShellEgress = {
      open: async () => ({ id: "c1", socket: SOCKET }),
      close: async () => {
        throw new Error("token-0123456789");
      },
      keep: () => {},
    };
    const { done } = exec(broken, "t1");
    await finish();
    await expect(done).resolves.toEqual({ exitCode: 0 });
    stderr.mockRestore();
    expect(written.join("")).toBe("pi-host: egress close failed (Error)\n");
  });
});

describe("the line after a refusal (M11R238, worker half)", () => {
  const run = async (hosts: EgressHost[], view: "host" | "system" = "host") => {
    if (view === "system")
      spec = { ...spec, view: "system", writable: join(root, "home/.pap/agents/.runs/atlas/t1") };
    const egress = port([{ id: "c1", socket: SOCKET }], { c1: reportOf("c1", hosts) });
    const { done, out } = exec(egress, "t1");
    await finish(undefined, "body");
    await done;
    return out.join("");
  };

  it("follows the command's own output and tells a thread how to ask", async () => {
    expect(await run([hostEntry("unlisted.test")])).toBe(
      `body\n[pap] The egress proxy refused: unlisted.test (not on this agent's host list). In this thread, ask the owner with network_request {"host": "unlisted.test"}.\n`,
    );
  });

  it("gives an isolated task the sentence that says it cannot ask", async () => {
    expect(await run([hostEntry("unlisted.test")], "system")).toBe(
      "body\n[pap] The egress proxy refused: unlisted.test (not on this agent's host list). An isolated task cannot ask for more hosts.\n",
    );
  });

  it("follows the session's kind, not the mount view: a child has no one to ask (Task 29b, carry 2)", async () => {
    const asked = async (advice: () => RefusalAdvice) => {
      const egress = port([{ id: "c1", socket: SOCKET }], {
        c1: reportOf("c1", [hostEntry("unlisted.test")]),
      });
      const { done, out } = exec(egress, "t1", undefined, advice);
      await finish(undefined, "body");
      await done;
      return out.join("");
    };
    // The mount view is `host` in all three: only the advice differs.
    expect(await asked(() => "child")).toBe(
      "body\n[pap] The egress proxy refused: unlisted.test (not on this agent's host list). This session cannot ask for more hosts; say in your answer which host you need.\n",
    );
    expect(await asked(() => "isolated")).toContain("An isolated task cannot ask for more hosts.");
    expect(await asked(() => "thread")).toContain(
      'In this thread, ask the owner with network_request {"host": "unlisted.test"}.',
    );
  });

  it("names each refused host with its reason, and asks only for a host that is not on the list", async () => {
    const line = await run([
      hostEntry("listed-elsewhere.test", { reason: "port", port: 8443 }),
      hostEntry("unlisted.test"),
      hostEntry("down.test", { reason: "dns_failed" }),
    ]);
    expect(line).toContain(
      "refused: listed-elsewhere.test (only ports 80 and 443 are open), unlisted.test (not on this agent's host list), down.test (the name could not be resolved).",
    );
    expect(line).toContain(`network_request {"host": "unlisted.test"}`);
    expect(line).not.toContain(`"host": "listed-elsewhere.test"`);
  });

  it("lists at most 8 hosts, once each, then 'and N more'", async () => {
    const many = Array.from({ length: 9 }, (_, n) => hostEntry(`h${n}.test`));
    const line = await run([...many, hostEntry("h0.test", { kind: "http", port: 80 })]);
    expect(line).toContain("h7.test (not on this agent's host list), and 1 more.");
    expect(line).not.toContain("h8.test");
    expect(line.match(/h0\.test/g)).toHaveLength(2);
  });

  it("writes nothing for a report with no refused host, and drops a host that is not a plain host name", async () => {
    expect(await run([hostEntry("allowed.test", { verdict: "allowed", reason: undefined })])).toBe("body");
    expect(await run([hostEntry("an unreadable host"), hostEntry("*.wild.test")])).toBe("body");
  });
});

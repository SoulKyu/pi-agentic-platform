import { describe, expect, it, vi } from "vitest";
import {
  IDENTITY,
  layout,
  SLOT,
  SLOT_B,
  spawnCommand,
  start,
  TOKEN,
  type FakeChild,
} from "../testing/guest-harness.ts";

// Mutants of the command side (RT-43), each killed by the case named:
//  - the token goes in the child's env instead of fd 3        -> "writes the token to fd 3 ..."
//  - a live slot is spawned twice / an exited slot again       -> "spawns a slot once"
//  - the ping reaches GuestCommand parsing first (AVM-P4)      -> "answers a ping with a pong ..."
//  - a closed gateway leaves the workers alive                 -> "kills every worker and exits 1 ..."
describe("runGuest commands", () => {
  it("picks the packages, then spawns with the token on fd 3 and never in the environment", async () => {
    const run = await start();
    await run.hello();
    run.gateway.send(spawnCommand({ packages: ["npm:a@1.0.0"] }));
    await vi.waitFor(() => expect(run.children).toHaveLength(1));
    await vi.waitFor(() => expect(run.gateway.frames).toContainEqual({ type: "spawned", slot: SLOT }));
    expect(run.picks).toEqual([["npm:a@1.0.0"]]);
    expect(run.order.slice(-2)).toEqual(["pick", "spawn"]);
    const child = run.children[0] as FakeChild;
    await vi.waitFor(() => expect(child.tokenEnded).toBe(true));
    expect(child.token).toBe(TOKEN);
    const env = run.spawnEnvs[0] as NodeJS.ProcessEnv;
    expect(JSON.stringify(env)).not.toContain(TOKEN);
    expect(env).toMatchObject({
      ...IDENTITY,
      PAP_WORKER_TRANSPORT: "socket",
      PAP_WORKER_SLOT: SLOT,
      PAP_SESSION_FILE: "/agent/.pi/sessions/s.jsonl",
      PI_CODING_AGENT_DIR: layout.piAgentDir,
      GIT_CEILING_DIRECTORIES: layout.root,
    });
    expect(run.logs.join("\n")).not.toContain(TOKEN);
  });

  it("exports the egress proxy to the worker, and no proxy keys without PAP_GUEST_PROXY", async () => {
    const run = await start({ env: { ...IDENTITY, PAP_GUEST_PROXY: "10.213.0.1:7843" } });
    await run.hello();
    run.gateway.send(spawnCommand());
    await vi.waitFor(() => expect(run.children).toHaveLength(1));
    const env = run.spawnEnvs[0] as NodeJS.ProcessEnv;
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"])
      expect(env[key]).toBe("http://10.213.0.1:7843");
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
    for (const key of ["NO_PROXY", "no_proxy"])
      expect((env[key] ?? "").split(",")).toEqual(
        expect.arrayContaining(["llm.internal", "claude.internal", "10.213.0.1", "localhost", "127.0.0.1"]),
      );
    expect("PAP_GUEST_PROXY" in env).toBe(false);

    const bare = await start();
    await bare.hello();
    bare.gateway.send(spawnCommand());
    await vi.waitFor(() => expect(bare.children).toHaveLength(1));
    const plain = bare.spawnEnvs[0] as NodeJS.ProcessEnv;
    for (const key of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
      "NO_PROXY",
      "no_proxy",
      "NODE_USE_ENV_PROXY",
    ])
      expect(key in plain).toBe(false);
  });

  it("gives a worker without a session file none, and strips a token the guest still held", async () => {
    const run = await start({
      env: { ...IDENTITY, PAP_SESSION_FILE: "/stale.jsonl", PAP_GATEWAY_TOKEN: TOKEN },
    });
    await run.hello();
    run.gateway.send(spawnCommand({ sessionFile: null }));
    await vi.waitFor(() => expect(run.children).toHaveLength(1));
    const env = run.spawnEnvs[0] as NodeJS.ProcessEnv;
    expect("PAP_SESSION_FILE" in env).toBe(false);
    expect("PAP_GATEWAY_TOKEN" in env).toBe(false);
  });

  it("spawns a slot once: a live slot and an exited one are ignored and logged (RT-35)", async () => {
    const run = await start();
    await run.hello();
    run.gateway.send(spawnCommand());
    await vi.waitFor(() => expect(run.children).toHaveLength(1));
    run.gateway.send(spawnCommand());
    await vi.waitFor(() => expect(run.logs.join("\n")).toContain("already running"));
    (run.children[0] as FakeChild).exit(0);
    await vi.waitFor(() =>
      expect(run.gateway.frames.some((f) => (f as { type: string }).type === "exited")).toBe(true),
    );
    run.gateway.send(spawnCommand());
    await vi.waitFor(() => expect(run.logs.join("\n")).toContain("already ran"));
    expect(run.children).toHaveLength(1);
    expect(run.gateway.frames.filter((f) => (f as { type: string }).type === "spawned")).toHaveLength(1);
  });

  it("reports a failed pick as an exit and spawns nothing", async () => {
    const run = await start({
      pick: () => {
        throw new Error("bad settings.json");
      },
    });
    await run.hello();
    run.gateway.send(spawnCommand());
    await vi.waitFor(() =>
      expect(run.gateway.frames).toContainEqual({
        type: "exited",
        slot: SLOT,
        code: 1,
        signal: null,
        tail: "pap-guest: the packages could not be set",
      }),
    );
    expect(run.children).toHaveLength(0);
  });

  it("sends exited with the code, the signal and the 8 KiB tail of stdout and stderr", async () => {
    const run = await start();
    await run.hello();
    run.gateway.send(spawnCommand());
    await vi.waitFor(() => expect(run.children).toHaveLength(1));
    const child = run.children[0] as FakeChild;
    child.stdout.emit("data", Buffer.from("x".repeat(6000)));
    child.stderr.emit("data", Buffer.from("y".repeat(6000)));
    child.stderr.emit("data", Buffer.from("last words"));
    child.exit(null, "SIGKILL");
    await vi.waitFor(() => expect(run.gateway.frames.at(-1)).toMatchObject({ type: "exited", slot: SLOT }));
    const exited = run.gateway.frames.at(-1) as { code: null; signal: string; tail: string };
    expect(exited.code).toBeNull();
    expect(exited.signal).toBe("SIGKILL");
    expect(exited.tail).toHaveLength(8192);
    expect(exited.tail.endsWith("yyyylast words")).toBe(true);
    expect(exited.tail.startsWith("x")).toBe(true);
  });

  it("finishes an exit whose pipes never close after a short wait", async () => {
    const run = await start();
    await run.hello();
    run.gateway.send(spawnCommand());
    await vi.waitFor(() => expect(run.children).toHaveLength(1));
    (run.children[0] as FakeChild).emit("exit", 0, null);
    await vi.waitFor(() => expect(run.clock.pending()).toBe(1));
    run.clock.advance(1000);
    await vi.waitFor(() => expect(run.gateway.frames.at(-1)).toMatchObject({ type: "exited", code: 0 }));
  });

  it("signals the process group of that worker only", async () => {
    const run = await start();
    await run.hello();
    run.gateway.send(spawnCommand());
    run.gateway.send(spawnCommand({ slot: SLOT_B }));
    await vi.waitFor(() => expect(run.children).toHaveLength(2));
    run.gateway.send({ type: "signal", slot: SLOT_B, signal: "SIGTERM" });
    run.gateway.send({ type: "signal", slot: "3".repeat(32), signal: "SIGKILL" });
    await vi.waitFor(() => expect(run.logs.join("\n")).toContain("no such worker"));
    expect(run.killed).toEqual([[1001, "SIGTERM"]]);
  });

  it("answers a ping with a pong before parsing, and never logs it as an unknown command (AVM-P4)", async () => {
    const run = await start();
    await run.hello();
    run.gateway.send({ type: "ping" });
    run.gateway.send({ type: "ping", junk: 1 });
    await vi.waitFor(() =>
      expect(run.gateway.frames.filter((f) => (f as { type: string }).type === "pong")).toHaveLength(2),
    );
    expect(run.logs).toEqual([]);
  });

  it("drops an unknown or malformed command, logs its type only, and carries on", async () => {
    const run = await start();
    await run.hello();
    run.gateway.send({ type: "reboot", note: "secret-note" });
    run.gateway.send(spawnCommand({ slot: "not-a-slot" }));
    run.gateway.send(7);
    await vi.waitFor(() => expect(run.logs).toHaveLength(3));
    expect(run.logs.every((line) => line.includes("dropped"))).toBe(true);
    expect(run.logs.join("\n")).not.toContain("secret-note");
    expect(run.logs.join("\n")).not.toContain("not-a-slot");
    run.gateway.send(spawnCommand());
    await vi.waitFor(() => expect(run.children).toHaveLength(1));
    expect(run.exits).toEqual([]);
  });
});

describe("runGuest operations", () => {
  const ID = "cd".repeat(16);

  it("runs an op through its handler and answers by id; a value too large for a frame becomes payload_too_large", async () => {
    const seen: string[] = [];
    const run = await start({
      ops: async (op) => {
        seen.push(op.name);
        if (op.name === "project.config") return { ok: true, value: "x".repeat(5 * 1024 * 1024) };
        return op.name === "git.status"
          ? { ok: true, value: { repo: false } }
          : { ok: false, code: "not_found" };
      },
    });
    await run.hello();
    run.gateway.send({ type: "op", id: ID, op: { name: "git.status" } });
    run.gateway.send({ type: "op", id: "ef".repeat(16), op: { name: "knowledge.state" } });
    run.gateway.send({ type: "op", id: "01".repeat(16), op: { name: "project.config" } });
    await vi.waitFor(() =>
      expect(run.gateway.frames.filter((f) => (f as { type: string }).type === "op_result")).toHaveLength(3),
    );
    expect(run.gateway.frames).toEqual(
      expect.arrayContaining([
        { type: "op_result", id: ID, ok: true, value: { repo: false } },
        { type: "op_result", id: "ef".repeat(16), ok: false, code: "not_found" },
        { type: "op_result", id: "01".repeat(16), ok: false, code: "payload_too_large" },
      ]),
    );
    expect(seen).toEqual(["git.status", "knowledge.state", "project.config"]);
  });

  it("answers failed when the VM has no project (an agent's guest)", async () => {
    const run = await start();
    await run.hello();
    run.gateway.send({ type: "op", id: ID, op: { name: "git.status" } });
    await vi.waitFor(() =>
      expect(run.gateway.frames).toContainEqual({ type: "op_result", id: ID, ok: false, code: "failed" }),
    );
  });
});

describe("runGuest preview services", () => {
  const ID = "cd".repeat(16);
  const svcOp = { name: "svc.list" };
  const fakeHost = () => {
    const seen: string[] = [];
    let closed = 0;
    let report: ((report: never) => void) | undefined;
    return {
      seen,
      closed: () => closed,
      emit: (value: unknown) => report?.(value as never),
      factory: (send: (report: never) => void) => {
        report = send;
        return {
          op: (op: { name: string }) => {
            seen.push(op.name);
            return Promise.resolve({ ok: true as const, value: { services: [] } });
          },
          connectTo: () => Promise.reject(new Error("unused")),
          closeAll: () => void closed++,
        };
      },
    };
  };

  it("svc.* goes to the service host in an agent's VM and a project box alike, before the box ops", async () => {
    const hosts = fakeHost();
    const boxOps: string[] = [];
    for (const ops of [
      undefined,
      async (op: { name: string }) => (boxOps.push(op.name), { ok: false as const, code: "failed" as const }),
    ]) {
      const run = await start({
        services: hosts.factory as never,
        ...(ops === undefined ? {} : { ops: ops as never }),
      });
      await run.hello();
      run.gateway.send({ type: "op", id: ID, op: svcOp });
      await vi.waitFor(() =>
        expect(run.gateway.frames).toContainEqual({
          type: "op_result",
          id: ID,
          ok: true,
          value: { services: [] },
        }),
      );
    }
    expect(hosts.seen).toEqual(["svc.list", "svc.list"]);
    expect(boxOps).toEqual([]);
  });

  it("answers failed to a svc op when the guest has no service host", async () => {
    const run = await start();
    await run.hello();
    run.gateway.send({ type: "op", id: ID, op: svcOp });
    await vi.waitFor(() =>
      expect(run.gateway.frames).toContainEqual({ type: "op_result", id: ID, ok: false, code: "failed" }),
    );
  });

  it("forwards a service report to the daemon as it is", async () => {
    const hosts = fakeHost();
    const run = await start({ services: hosts.factory as never });
    await run.hello();
    const report = { type: "service", id: ID, state: "exited", code: 1, signal: null };
    hosts.emit(report);
    await vi.waitFor(() => expect(run.gateway.frames).toContainEqual(report));
  });

  it("closeAll on shutdown stops every service, and on a closed gateway too", async () => {
    const hosts = fakeHost();
    const run = await start({ services: hosts.factory as never });
    await run.hello();
    run.gateway.send({ type: "shutdown" });
    await vi.waitFor(() => expect(run.exits).toEqual([0]));
    expect(hosts.closed()).toBe(1);
    const lost = fakeHost();
    const other = await start({ services: lost.factory as never });
    await other.hello();
    other.gateway.hangUp();
    await vi.waitFor(() => expect(other.exits).toEqual([1]));
    expect(lost.closed()).toBe(1);
  });

  it("stops the services, then exits, when the guest is told to terminate", async () => {
    const hosts = fakeHost();
    let terminate: () => void = () => undefined;
    const run = await start({
      services: hosts.factory as never,
      onTerminate: (handler) => void (terminate = handler),
    });
    await run.hello();
    terminate();
    await vi.waitFor(() => expect(run.exits).toEqual([0]));
    expect(hosts.closed()).toBe(1);
  });
});

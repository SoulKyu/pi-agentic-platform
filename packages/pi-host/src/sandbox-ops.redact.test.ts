import type { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { SandboxSpec } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRedactor } from "./policy/redact.ts";
import { takeStreamCount } from "./redact-stream.ts";
import { sandboxedShell, toolCall } from "./sandbox-ops.ts";

// Pi's bash tool writes what `onData` hands it to a full-output file once the output passes its limit, before any result
// is redacted. The shell therefore hands Pi redacted bytes only, whichever way the output is cut into chunks.
const SECRET = "pap-test-secret-0a1b2c3d";
const redactor = createRedactor({ entries: [{ name: "TOKEN", value: SECRET }] });

let root: string;
let spec: SandboxSpec;
let kill: ReturnType<typeof vi.spyOn>;
let child: EventEmitter & { pid: number; stdout: PassThrough; stderr: PassThrough };
const fakeSpawn = (() => {
  child = Object.assign(new EventEmitter(), {
    pid: 424_242,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  return child;
}) as unknown as typeof nodeSpawn;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-sandbox-redact-")));
  const home = join(root, "home/.pap/agents/atlas");
  for (const dir of [home, join(root, "var-log")]) mkdirSync(dir, { recursive: true });
  spec = {
    bwrap: "/usr/bin/bwrap",
    view: "host",
    home,
    writable: home,
    hide: [join(root, "home"), join(root, "var-log")],
    network: false,
    egress: null,
  };
  kill = vi.spyOn(process, "kill").mockImplementation(() => true);
});
afterEach(() => {
  kill.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

const exec = (redact?: () => typeof redactor, callId?: string) => {
  const seen: Buffer[] = [];
  const ops = sandboxedShell(spec, () => ({ PATH: "/usr/bin" }), {
    spawn: fakeSpawn,
    ...(redact ? { redact } : {}),
  });
  const start = () => ops.exec("echo hi", "/", { onData: (data) => void seen.push(data) });
  const done = callId === undefined ? start() : toolCall.run(callId, start);
  return { seen, done, text: () => Buffer.concat(seen).toString() };
};

describe("the sandboxed shell hands Pi redacted output", () => {
  it("replaces a value cut by the pipe into two chunks, on stdout and on stderr, and flushes the held tail at the end", async () => {
    const { done, text } = exec(() => redactor);
    child.stdout.write(`out ${SECRET.slice(0, 9)}`);
    child.stdout.write(`${SECRET.slice(9)} more\n`);
    child.stderr.write(`err ${SECRET}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(text()).not.toContain(SECRET.slice(0, 6));
    child.emit("close", 0, null);
    await expect(done).resolves.toEqual({ exitCode: 0 });
    expect(text()).toContain("out [SECRET:TOKEN] more\n");
    expect(text()).toContain("err [SECRET:TOKEN]\n");
    expect(text()).not.toContain(SECRET);
  });

  it("flushes what it held before the call fails or is cut short", async () => {
    const { done, text } = exec(() => redactor);
    child.stdout.write("tail without a newline");
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("error", new Error("spawn failed"));
    await expect(done).rejects.toThrow("spawn failed");
    expect(text()).toBe("tail without a newline");
  });

  it.each([
    ["no redactor is wired", undefined],
    ["the worker wires its redactor and knows no secret", () => createRedactor({ entries: [] })],
  ] as const)("passes the bytes through untouched when %s", async (_name, redact) => {
    const { done, text } = exec(redact as (() => typeof redactor) | undefined);
    child.stdout.write(`raw ${SECRET}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("close", 0, null);
    await done;
    expect(text()).toBe(`raw ${SECRET}\n`);
  });
});

describe("the line pap adds after a networked command (I3)", () => {
  const SOCKET = "/run/user/1000/pap/ab12cd/egress/0/1.s";
  const hostReport = (host: string) => ({
    type: "egress_report" as const,
    id: "c1",
    hosts: [
      { host, port: 80, kind: "http" as const, verdict: "refused" as const, reason: "not_listed" as const },
    ],
    truncated: false,
    up: 0,
    down: 0,
  });

  it("redacts a refused host that holds a value before it reaches Pi", async () => {
    spec = {
      ...spec,
      network: true,
      egress: { python: "/usr/bin/python3", forwarder: "/srv/pap/egress/fwd.py" },
    };
    const seen: Buffer[] = [];
    const egress = {
      open: async () => ({ id: "c1", socket: SOCKET }),
      close: async () => hostReport(`${SECRET}.exfil.test`),
      keep: () => {},
    };
    const ops = sandboxedShell(spec, () => ({ PATH: "/usr/bin" }), {
      spawn: fakeSpawn,
      egress,
      redact: () => redactor,
    });
    const done = toolCall.run("t1", () =>
      ops.exec("curl x", "/", { onData: (data) => void seen.push(data) }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write("out\n");
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("close", 0, null);
    await done;
    const text = Buffer.concat(seen).toString();
    expect(text).toContain("The egress proxy refused: [SECRET:TOKEN].exfil.test");
    expect(text).not.toContain(SECRET);
  });
});

describe("the redactions of a command are counted for stage 06 (I4)", () => {
  it("counts each replacement once per tool call, stdout and stderr together, and hands the count out once", async () => {
    const { done } = exec(() => redactor, "call-1");
    child.stdout.write(`a ${SECRET.slice(0, 9)}`);
    child.stdout.write(`${SECRET.slice(9)}\nb ${SECRET}\n`);
    child.stderr.write(`c ${SECRET}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("close", 0, null);
    await done;
    expect(takeStreamCount("call-1")).toBe(3);
    expect(takeStreamCount("call-1")).toBe(0);
  });
});

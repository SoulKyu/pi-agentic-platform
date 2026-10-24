import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "./frames.ts";
import { methods } from "./methods.ts";
import { STREAMS } from "./streams.ts";
import {
  TERMINAL_LIMITS,
  TerminalExit,
  TerminalId,
  TerminalRequestId,
  TerminalStreamEvent,
  TerminalView,
} from "./terminal.ts";

const id = "A".repeat(22);
const view = {
  id,
  cwd: "/work",
  sessionId: null,
  projectId: null,
  cols: 80,
  rows: 24,
  status: "running",
  exitCode: null,
  signal: null,
  createdAt: 1,
} as const;

describe("terminal ids", () => {
  it("TerminalId is 22 base64url characters", () => {
    expect(TerminalId.safeParse(id).success).toBe(true);
    for (const bad of ["A".repeat(21), "A".repeat(23), `${"A".repeat(21)}/`, `${"A".repeat(21)}+`])
      expect(TerminalId.safeParse(bad).success, bad).toBe(false);
  });
  it("TerminalRequestId is 16 to 64 base64url characters", () => {
    for (const ok of ["a".repeat(16), "a".repeat(64), "A-_".repeat(8)])
      expect(TerminalRequestId.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["a".repeat(15), "a".repeat(65), `${"a".repeat(15)}=`])
      expect(TerminalRequestId.safeParse(bad).success, bad).toBe(false);
  });
});

describe("terminal methods", () => {
  const create = { requestId: "r".repeat(16), cwd: "/work", cols: 80, rows: 24 };
  it("refuses a size outside the PTY's range", () => {
    const { params } = methods["terminal.create"];
    expect(params.safeParse(create).success).toBe(true);
    expect(params.safeParse({ ...create, cols: 1 }).success).toBe(false);
    expect(params.safeParse({ ...create, cols: 501 }).success).toBe(false);
    expect(params.safeParse({ ...create, rows: 1 }).success).toBe(false);
    expect(params.safeParse({ ...create, rows: 201 }).success).toBe(false);
    expect(params.safeParse({ ...create, cwd: "work" }).success).toBe(false);
    expect(params.safeParse({ ...create, requestId: "short" }).success).toBe(false);
  });
  it("refuses a negative or fractional `after`", () => {
    const { params } = methods["terminal.attach"];
    expect(params.safeParse({ terminalId: id, after: 0 }).success).toBe(true);
    expect(params.safeParse({ terminalId: id, after: -1 }).success).toBe(false);
    expect(params.safeParse({ terminalId: id, after: 1.5 }).success).toBe(false);
  });
  it("are all idempotent and need a terminal permission", () => {
    const names = [
      "subscribe.terminal",
      "terminal.create",
      "terminal.attach",
      "terminal.detach",
      "terminal.resize",
      "terminal.close",
    ] as const;
    for (const name of names) expect(methods[name].idempotent, name).toBe(true);
    expect(methods["subscribe.terminal"].permission).toBe("terminal:read");
    for (const name of names.slice(1)) expect(methods[name].permission, name).toBe("terminal:operate");
  });
  it("come from terminalMethods, never defined inline (M5R111)", () => {
    const source = readFileSync(new URL("./methods.ts", import.meta.url), "utf8");
    expect(source).toContain("...terminalMethods");
    for (const name of ["subscribe.terminal", "terminal.create", "terminal.close"])
      expect(source).not.toContain(`"${name}": defineMethod`);
  });
});

describe("the terminal stream", () => {
  it("is a stream and a capability", () => {
    expect(STREAMS).toContain("terminal");
    expect(CAPABILITIES).toContain("terminal");
  });
  it("holds at most 72 terminals in a snapshot", () => {
    const snapshot = (count: number) => ({
      kind: "snapshot",
      terminals: Array.from({ length: count }, () => view),
    });
    expect(TERMINAL_LIMITS.listed).toBe(72);
    expect(TerminalStreamEvent.safeParse(snapshot(72)).success).toBe(true);
    expect(TerminalStreamEvent.safeParse(snapshot(73)).success).toBe(false);
  });
  it("carries a terminal, a close and an exit payload", () => {
    expect(TerminalStreamEvent.safeParse({ kind: "terminal", terminal: view }).success).toBe(true);
    expect(TerminalStreamEvent.safeParse({ kind: "closed", id }).success).toBe(true);
    expect(TerminalStreamEvent.safeParse({ kind: "closed", id: "x" }).success).toBe(false);
    expect(TerminalView.safeParse({ ...view, status: "gone" }).success).toBe(false);
    const project = "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11";
    expect(TerminalView.safeParse({ ...view, projectId: project }).success).toBe(true);
    expect(TerminalView.safeParse({ ...view, projectId: "not-a-project" }).success).toBe(false);
    expect(TerminalExit.safeParse({ code: 0, signal: null }).success).toBe(true);
    expect(TerminalExit.safeParse({ code: null, signal: "SIGHUP" }).success).toBe(true);
  });
});

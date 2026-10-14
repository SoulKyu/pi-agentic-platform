import { describe, expect, it } from "vitest";
import { DaemonToWorker, MAX_LISTED_COMMANDS, methods, SessionCommandsData } from "./index.ts";

const command = (name: string) => ({ name, description: null, source: "prompt", builtinMcp: false });
const list = (count: number) => Array.from({ length: count }, (_, i) => command(`c${i}`));

describe("sessions.commands", () => {
  it("is a read of the session, idempotent, and a cold session may fail to start", () => {
    const method = methods["sessions.commands"];
    expect(method.permission).toBe("sessions:read");
    expect(method.idempotent).toBe(true);
    expect(method.params.safeParse({ sessionId: "s1" }).success).toBe(true);
    expect(method.errors).toEqual(
      expect.arrayContaining(["not_found", "capacity", "worker_failed", "command_failed", "timeout"]),
    );
  });

  it("caps the list at 500 and bounds each entry", () => {
    expect(MAX_LISTED_COMMANDS).toBe(500);
    expect(SessionCommandsData.safeParse({ commands: list(500), truncated: true }).success).toBe(true);
    expect(SessionCommandsData.safeParse({ commands: list(501), truncated: true }).success).toBe(false);
    const entry = (patch: object) => ({ commands: [{ ...command("a"), ...patch }], truncated: false });
    expect(SessionCommandsData.safeParse(entry({ source: "other" })).success).toBe(false);
    expect(SessionCommandsData.safeParse(entry({ name: "" })).success).toBe(false);
    expect(SessionCommandsData.safeParse(entry({ name: "n".repeat(129) })).success).toBe(false);
    expect(SessionCommandsData.safeParse(entry({ description: "d".repeat(1001) })).success).toBe(false);
    expect(SessionCommandsData.safeParse(entry({ description: "d".repeat(1000) })).success).toBe(true);
    expect(methods["sessions.commands"].result).toBe(SessionCommandsData);
  });

  it("is a worker command with no parameters", () => {
    expect(DaemonToWorker.safeParse({ type: "get_commands", id: "r1" }).success).toBe(true);
  });
});

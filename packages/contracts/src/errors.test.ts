import { describe, expect, it } from "vitest";
import { ERROR_CODES, ERROR_MESSAGES, PapError, ResponseFrame } from "./index.ts";

describe("error codes", () => {
  it("gives every code a fixed message of its own", () => {
    const messages = ERROR_CODES.map((code) => ERROR_MESSAGES[code]);
    expect(messages.every((message) => message.length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(ERROR_CODES.length);
  });

  it("tells a paused agent's owner where to resume it: its header, as the web copy does", () => {
    expect(ERROR_MESSAGES.agent_paused).toBe("This agent is paused. Resume it from its header.");
  });

  it("keeps a slow answer apart from a dead worker", () => {
    expect(ERROR_CODES).toContain("timeout");
    expect(new PapError("timeout").code).toBe("timeout");
    expect(new PapError("timeout").message).toBe("The session process did not answer in time.");
    expect(ERROR_MESSAGES.timeout).not.toBe(ERROR_MESSAGES.worker_failed);
  });

  it("has a fixed message for a command the worker refused, which names nothing the worker said", () => {
    expect(new PapError("command_failed").message).toBe("The session could not complete this command.");
  });

  it("has one shared message for a full list", () => {
    expect(ERROR_MESSAGES.limit_reached).toBe("This list is full. Remove an entry first.");
  });

  it("asks for the password again with a fixed message", () => {
    expect(ERROR_MESSAGES.step_up_required).toBe("Confirm your password to continue.");
  });

  it("has the shared full-list message, fixed (agreement 4)", () => {
    expect(ERROR_MESSAGES.limit_reached).toBe("This list is full. Remove an entry first.");
    expect(ERROR_CODES.indexOf("limit_reached")).toBe(ERROR_CODES.indexOf("command_failed") + 1);
  });

  it("has the M8 codes before unknown_method, with fixed messages", () => {
    expect(ERROR_CODES).toContain("protected_path");
    expect(ERROR_CODES).toContain("terminal_unavailable");
    expect(ERROR_CODES.indexOf("protected_path")).toBeLessThan(ERROR_CODES.indexOf("unknown_method"));
    expect(ERROR_CODES.indexOf("terminal_unavailable")).toBeLessThan(ERROR_CODES.indexOf("unknown_method"));
    expect(ERROR_MESSAGES.protected_path).toBe(
      "This file can run commands later, such as a git hook or an editor task. Confirm to save it.",
    );
    expect(ERROR_MESSAGES.terminal_unavailable).toBe(
      "Terminals are not available on this server: the terminal module did not load.",
    );
  });

  it("has the helper failure code with a fixed message that names no helper text (agreement 3: membership)", () => {
    expect(ERROR_CODES).toContain("helper_failed");
    expect(ERROR_CODES.indexOf("helper_failed")).toBeLessThan(ERROR_CODES.indexOf("unknown_method"));
    expect(ERROR_MESSAGES.helper_failed).toBe("The Pi configuration helper failed.");
    expect(new PapError("helper_failed").message).toBe("The Pi configuration helper failed.");
  });

  it("has the three Pi configuration codes with fixed messages, before unknown_method (agreement 3: membership)", () => {
    const expected = {
      project_scope: "This project sets its own value in .pi/settings.json, which wins over the global one.",
      config_invalid: "A Pi configuration file is not valid. Fix the file, then try again.",
      config_path_refused:
        "Pi refused this configuration path: it must be a regular file inside your folders.",
    } as const;
    for (const [code, message] of Object.entries(expected)) {
      expect(ERROR_CODES).toContain(code);
      expect(ERROR_CODES.indexOf(code as never)).toBeLessThan(ERROR_CODES.indexOf("unknown_method"));
      expect(ERROR_MESSAGES[code as keyof typeof expected]).toBe(message);
      expect(new PapError(code as keyof typeof expected).message).toBe(message);
    }
  });

  it("has the three M10 codes with fixed messages, before unknown_method (membership, never adjacency)", () => {
    const expected = {
      automation_paused: "Automation is paused. Resume it on the Tasks board or in Settings › Automation.",
      budget_reached:
        "Today's automation budget is spent. Raise it in Settings › Automation, or wait for tomorrow.",
      disk_low:
        "The disk is almost full: pap keeps some space free for its database. Free some space, then try again.",
    } as const;
    for (const [code, message] of Object.entries(expected)) {
      expect(ERROR_CODES).toContain(code);
      expect(ERROR_CODES.indexOf(code as never)).toBeLessThan(ERROR_CODES.indexOf("unknown_method"));
      expect(ERROR_MESSAGES[code as keyof typeof expected]).toBe(message);
      expect(new PapError(code as keyof typeof expected).message).toBe(message);
    }
  });

  it("travels in an error response frame", () => {
    expect(ResponseFrame.safeParse({ id: 1, ok: false, error: { code: "timeout" } }).success).toBe(true);
  });
});

describe("M11 codes (membership, never adjacency)", () => {
  it("has the two agent codes with fixed messages, before unknown_method", () => {
    const expected = {
      sandbox_unavailable: "This agent's sandbox cannot run on this server as set up. See Settings › Agents.",
      agent_paused: "This agent is paused. Resume it from its header.",
    } as const;
    for (const [code, message] of Object.entries(expected)) {
      expect(ERROR_CODES).toContain(code);
      expect(ERROR_CODES.indexOf(code as never)).toBeLessThan(ERROR_CODES.indexOf("unknown_method"));
      expect(ERROR_MESSAGES[code as keyof typeof expected]).toBe(message);
      expect(new PapError(code as keyof typeof expected).message).toBe(message);
    }
  });
});

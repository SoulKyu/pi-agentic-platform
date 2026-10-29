import { describe, expect, it } from "vitest";
import {
  PreviewDecl,
  SERVICE_LIMITS,
  ServiceCommand,
  ServiceName,
  ServicePort,
  ServiceView,
} from "./preview-service.ts";

describe("preview service schemas", () => {
  it("refuses ports under 1024, the bridge ports 7841 to 7843 and over 65535", () => {
    for (const port of [1023, 7841, 7842, 7843, 65_536, 80, 1.5]) {
      expect(ServicePort.safeParse(port).success, String(port)).toBe(false);
    }
    for (const port of [1024, 7840, 7844, 8000, 65_535]) {
      expect(ServicePort.safeParse(port).success, String(port)).toBe(true);
    }
  });

  it("names a service with lower case letters, digits and dashes, 1 to 32", () => {
    for (const name of ["a", "my-site", "a".repeat(32), "0"]) {
      expect(ServiceName.safeParse(name).success, name).toBe(true);
    }
    for (const name of ["A", "a_b", "a".repeat(33), "", "a b", "a/b"]) {
      expect(ServiceName.safeParse(name).success, name).toBe(false);
    }
  });

  it("refuses a command with a NUL, a bidi control or a line separator; tab and new line stay", () => {
    const bad = [0, 0x202e, 0x2028, 0x2029, 0x200b, 0x0d, 0x1b].map(
      (code) => `echo ${String.fromCodePoint(code)}x`,
    );
    for (const command of bad) expect(ServiceCommand.safeParse(command).success, command).toBe(false);
    expect(ServiceCommand.safeParse("python3 -m http.server\t8000\nsleep 1").success).toBe(true);
    expect(ServiceCommand.safeParse("").success).toBe(false);
    expect(ServiceCommand.safeParse("x".repeat(SERVICE_LIMITS.commandChars)).success).toBe(true);
    expect(ServiceCommand.safeParse("x".repeat(SERVICE_LIMITS.commandChars + 1)).success).toBe(false);
  });

  it("checks a declaration and a view strictly", () => {
    expect(PreviewDecl.safeParse({ command: "npm run dev", port: 5173 }).success).toBe(true);
    expect(PreviewDecl.safeParse({ command: "npm run dev", port: 5173, extra: 1 }).success).toBe(false);
    const view = {
      id: "a".repeat(32),
      name: "site",
      port: 8000,
      state: "running",
      reason: null,
      startedAt: 1,
      network: false,
    };
    expect(ServiceView.safeParse(view).success).toBe(true);
    expect(ServiceView.safeParse({ ...view, reason: "port_timeout" }).success).toBe(true);
    expect(ServiceView.safeParse({ ...view, state: "paused" }).success).toBe(false);
    expect(ServiceView.safeParse({ ...view, reason: "other" }).success).toBe(false);
    expect(ServiceView.safeParse({ ...view, id: "g".repeat(32) }).success).toBe(false);
  });
});

// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { translate } from "../../i18n/index.ts";

vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));

it("loading the session screen registers M2's session strings, and its first import is the registration", async () => {
  expect(translate("en", "sessions.transcript.loadOlder")).toBe("sessions.transcript.loadOlder");
  await import("./SessionScreen.tsx");
  expect(translate("en", "sessions.transcript.loadOlder")).toBe("Load older messages");
  expect(translate("fr", "sessions.transcript.loadOlder")).toBe("Charger les messages plus anciens");
  const source = readFileSync(join(import.meta.dirname, "SessionScreen.tsx"), "utf8");
  expect(source.split("\n")[0]).toBe('import "./register-session-catalog.ts";');
});

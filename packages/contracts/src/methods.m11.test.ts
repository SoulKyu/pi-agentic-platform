import { describe, expect, it } from "vitest";
import { methods } from "./index.ts";

const GATE = ["sandbox_unavailable", "agent_paused", "invalid_cwd"] as const;

describe("the launch gate's codes are declared (M11R182)", () => {
  it("every method that can start a worker (worker_failed) and usage.resumeNow declare them", () => {
    const starters = Object.values(methods).filter((def) => def.errors.includes("worker_failed"));
    expect(starters.length).toBeGreaterThan(15);
    for (const def of [...starters, methods["usage.resumeNow"]]) {
      for (const code of GATE) expect(def.errors, `${def.name} declares ${code}`).toContain(code);
    }
  });

  it("names the methods of the plan", () => {
    const names = [
      "sessions.prompt",
      "sessions.reopen",
      "sessions.navigate",
      "sessions.compact",
      "sessions.rename",
      "sessions.autoName",
      "sessions.exportHtml",
      "sessions.models",
      "sessions.commands",
      "sessions.setModel",
      "sessions.setThinking",
      "sessions.setTools",
      "sessions.create",
      "lanes.newSession",
      "lanes.suggestCommit",
      "usage.resumeNow",
    ] as const;
    for (const name of names) {
      for (const code of GATE) expect(methods[name].errors, `${name} ${code}`).toContain(code);
    }
  });

  it("sessions.clone gains bad_request", () => {
    expect(methods["sessions.clone"].errors).toContain("bad_request");
  });
});

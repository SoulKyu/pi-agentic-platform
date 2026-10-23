import { describe, expect, it } from "vitest";
import { shellEn, shellFr } from "./shell.ts";

describe("error.sandbox_unavailable", () => {
  it("says agents run in microVMs and what the machine needs", () => {
    expect(shellEn["error.sandbox_unavailable"]).toBe(
      "Agents run in microVMs: this machine needs KVM and `sudo pap vm setup`.",
    );
    expect(shellFr["error.sandbox_unavailable"]).toBe(
      "Les agents tournent dans des microVM : cette machine a besoin de KVM et de `sudo pap vm setup`.",
    );
  });
});

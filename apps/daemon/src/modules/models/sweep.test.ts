import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { sweepValidationCopies } from "./sweep.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-sweep-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe("sweepValidationCopies", () => {
  it("removes a copy a killed helper left, and nothing else under the pap home", async () => {
    mkdirSync(join(home, "models-check", "check-abc"), { recursive: true });
    writeFileSync(join(home, "models-check", "check-abc", "models.json"), '{"apiKey":"sk-LEFT-BEHIND"}');
    writeFileSync(join(home, "state.db"), "keep");
    const { logger, lines } = captureLogger();
    await sweepValidationCopies(home, logger);
    expect(readdirSync(home)).toEqual(["state.db"]);
    expect(lines).toEqual([]);
  });

  it("does nothing when there is no folder", async () => {
    const { logger, lines } = captureLogger();
    await sweepValidationCopies(home, logger);
    expect(lines).toEqual([]);
  });

  it("logs a failed removal without the path", async () => {
    vi.spyOn(fs, "rm").mockRejectedValue(new Error(`EACCES ${home}/models-check`));
    const { logger, lines } = captureLogger();
    await sweepValidationCopies(home, logger);
    expect(lines.map((line) => line.msg)).toEqual(["models_check_sweep_failed"]);
    expect(JSON.stringify(lines)).not.toContain(home);
  });
});

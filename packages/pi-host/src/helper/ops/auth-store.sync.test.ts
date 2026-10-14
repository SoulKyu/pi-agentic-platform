import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeModelsBed, type ModelsBed } from "../../testing/models-bed.ts";
import { setApiKey } from "./auth.ts";

let bed: ModelsBed;
beforeEach(async () => {
  bed = await makeModelsBed();
  vi.stubEnv("PI_OFFLINE", "1");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await bed.cleanup();
});

describe("auth.json after a folder sync failure", () => {
  it("keeps the credential, answers ok and leaves a helper log line with the code only", async () => {
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === bed.agentDir)
        throw Object.assign(new Error(`${bed.agentDir} sk-LEAK`), { code: "EIO" });
      return open(...args);
    });
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    expect(await setApiKey.run({ provider: "anthropic", key: "sk-STORED" }, bed.context())).toEqual({
      ok: true,
    });
    expect(JSON.parse(await fs.readFile(join(bed.agentDir, "auth.json"), "utf8"))).toMatchObject({
      anthropic: { type: "api_key", key: "sk-STORED" },
    });
    expect(lines).toContain("pap-helper: auth.json folder sync failed (EIO)\n");
    expect(lines.join("")).not.toContain("sk-");
  });
});

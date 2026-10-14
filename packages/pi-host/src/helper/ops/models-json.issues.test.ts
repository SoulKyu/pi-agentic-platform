import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeModelsBed, type ModelsBed } from "../../testing/models-bed.ts";
import { configGet, configSave } from "./models-json.ts";

const KEY = "ab".repeat(32);
let bed: ModelsBed;
let file: string;
let outside: string;
beforeEach(async () => {
  bed = await makeModelsBed();
  file = join(bed.agentDir, "models.json");
  outside = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "pap-outside-")));
  vi.stubEnv("PI_OFFLINE", "1");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await bed.cleanup();
  await fs.rm(outside, { recursive: true, force: true });
});
const get = () => configGet.run({ revisionKey: KEY }, bed.context());
const save = (text: string, baseRevision: string) =>
  configSave.run({ text, baseRevision, revisionKey: KEY }, bed.context());

describe("models.config: positions in issues", () => {
  it("takes the position of a parse error only from the parser's offset, never from the text", async () => {
    const cases: Array<[string, string]> = [
      [
        `{"a": "x in JSON at position 123" "b": 1}`,
        `line 1, column ${`{"a": "x in JSON at position 123" `.length + 1}: invalid JSON`,
      ],
      [`{"a": position 77}`, "invalid JSON"],
      [
        `{"a": "in JSON at position 99"} extra`,
        `line 1, column ${`{"a": "in JSON at position 99"} `.length + 1}: invalid JSON`,
      ],
    ];
    for (const [text, issue] of cases) {
      await fs.writeFile(file, text);
      expect((await get()).issues).toEqual([issue]);
    }
  });

  it("reports a syntax error at its place in the submitted text, not in the text with secrets restored", async () => {
    const long = "k".repeat(300);
    await fs.writeFile(file, `{"providers": {"mine": {"apiKey": "${long}", "baseUrl": "http://x/v1"}}}`);
    const { revision } = await get();
    const submitted = `{"providers": {"mine": {"apiKey": "<redacted:0>" "baseUrl": "http://x/v1"}}}`;
    const result = await save(submitted, revision);
    expect(result).toEqual({
      code: "config_invalid",
      issues: [`line 1, column ${submitted.indexOf('"baseUrl"') + 1}: invalid JSON`],
    });
    expect(JSON.stringify(result)).not.toContain(long);
  });
});

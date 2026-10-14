import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeModelsBed, type ModelsBed, SECRET_MODELS_KEY } from "../../testing/models-bed.ts";
import { HelperOpError } from "../ops.ts";
import { configGet, configSave } from "./models-json.ts";

let bed: ModelsBed;
let file: string;
let outside: string;
const KEY = "ab".repeat(32);
const sha = (text: string) => createHmac("sha256", KEY).update(text).digest("hex");
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
const failureOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error as HelperOpError,
  );
const SAMPLE = `{
  // my provider
  "providers": {
    "mine": {
      "baseUrl": "http://localhost:1/v1",
      "apiKey": "${SECRET_MODELS_KEY}",
      "api": "openai-completions",
      "headers": { "X-Org": "org-LITERAL-HEADER" },
      "models": [{ "id": "m1" }, { "id": "m2" }],
    },
  },
}
`;

describe("models.config.get", () => {
  it("answers null text, the revision of an empty text and the fixed path when there is no file", async () => {
    expect(await get()).toEqual({ text: null, issues: [], revision: sha(""), path: file });
  });

  it("answers the masked text and the revision of the real text", async () => {
    await fs.writeFile(file, SAMPLE);
    const result = await get();
    expect(result.revision).toBe(sha(SAMPLE));
    expect(result.text).toContain("<redacted:0>");
    expect(result.text).toContain("<redacted:1>");
    expect(result.text).toContain("// my provider");
    expect(JSON.stringify(result)).not.toContain(SECRET_MODELS_KEY);
    expect(JSON.stringify(result)).not.toContain("org-LITERAL-HEADER");
  });

  it("never shows a key kept in a comment", async () => {
    await fs.writeFile(file, `{\n // "apiKey": "sk-COMMENTED-OUT"\n "providers": {}\n}`);
    expect(JSON.stringify(await get())).not.toContain("sk-COMMENTED-OUT");
  });

  it("shows no text for a file that does not parse, only a position and a fixed phrase", async () => {
    const bad: Array<[string, string, string]> = [
      [
        "a missing comma before a key",
        `{"x": {"baseUrl": "https://h"\n "apiKey": "sk-BROKEN-1"}}`,
        "line 2, column",
      ],
      ["a missing colon", `{"apiKey" "sk-BROKEN-2"}`, "line 1, column"],
      ["an unterminated string", `{"providers": {"mine": {"apiKey": "sk-BROKEN-3`, "unterminated string"],
      ["an unterminated comment", `{ /* "apiKey": "sk-BROKEN-4" }`, "unterminated comment"],
      ["a block comment", `{ /* c */ "apiKey": "sk-BROKEN-5" }`, "line 1, column"],
      ["a single quote", `{'apiKey': 'sk-BROKEN-6'}`, "line 1, column"],
    ];
    for (const [, text, phrase] of bad) {
      await fs.writeFile(file, text);
      const result = await get();
      expect(result.text).toBeNull();
      expect(result.revision).toBe(sha(text));
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toContain(phrase);
      expect(JSON.stringify(result)).not.toContain("sk-BROKEN");
    }
  });

  it("makes a revision that is not a plain hash of the file, stable under one key", async () => {
    await fs.writeFile(file, SAMPLE);
    const first = await get();
    expect(first.revision).not.toBe(createHash("sha256").update(SAMPLE).digest("hex"));
    expect((await get()).revision).toBe(first.revision);
    const other = await configGet.run({ revisionKey: "cd".repeat(32) }, bed.context());
    expect(other.revision).not.toBe(first.revision);
  });

  it("refuses a file over 1 MiB, a FIFO without blocking, and a link outside", async () => {
    await fs.writeFile(file, " ".repeat(1.5 * 1024 * 1024));
    expect(await failureOf(get())).toMatchObject({ code: "config_path_refused" });
    await fs.rm(file);
    execFileSync("mkfifo", [file]);
    const error = await vi.waitFor(() => failureOf(get()), { timeout: 2000 });
    expect(error).toMatchObject({ code: "config_path_refused" });
    await fs.rm(file);
    await fs.writeFile(join(outside, "models.json"), SAMPLE);
    await fs.symlink(join(outside, "models.json"), file);
    expect(await failureOf(get())).toMatchObject({ code: "config_path_refused" });
  });
});

describe("models.config.save", () => {
  it("get then save unchanged leaves the file byte-identical", async () => {
    await fs.writeFile(file, SAMPLE);
    const { text, revision } = await get();
    const result = await save(text ?? "", revision);
    expect(result).toMatchObject({ revision: sha(SAMPLE) });
    expect(await fs.readFile(file, "utf8")).toBe(SAMPLE);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("keeps the secrets when the text around them changes, and takes a new literal", async () => {
    await fs.writeFile(file, SAMPLE);
    const { text, revision } = await get();
    const edited = (text ?? "")
      .replace(`"id": "m2"`, `"id": "m3"`)
      .replace(`"<redacted:1>"`, `"org-NEW"`)
      .replace("my provider", "renamed");
    const result = await save(edited, revision);
    const written = await fs.readFile(file, "utf8");
    expect(written).toContain(`"apiKey": "${SECRET_MODELS_KEY}"`);
    expect(written).toContain(`"X-Org": "org-NEW"`);
    expect(written).toContain(`"m3"`);
    expect(written).toContain("// renamed");
    expect(result).toMatchObject({ revision: sha(written) });
  });

  it("creates the file, mode 0600, when there is none", async () => {
    const text = `{"providers":{"mine":{"baseUrl":"http://x/v1","api":"openai-completions","models":[{"id":"m1"}]}}}`;
    await save(text, sha(""));
    expect(await fs.readFile(file, "utf8")).toBe(text);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("forces 0600 on a file that was more open", async () => {
    await fs.writeFile(file, SAMPLE, { mode: 0o644 });
    await fs.chmod(file, 0o644);
    const { text, revision } = await get();
    await save(text ?? "", revision);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("answers conflict for the revision of an older text and writes nothing", async () => {
    await fs.writeFile(file, SAMPLE);
    const { text, revision } = await get();
    await fs.writeFile(file, SAMPLE.replace("m1", "other"));
    const before = await fs.readFile(file, "utf8");
    const validation = vi.spyOn(fs, "mkdtemp");
    expect(await failureOf(save(text ?? "", revision))).toMatchObject({ code: "conflict" });
    expect(await fs.readFile(file, "utf8")).toBe(before);
    // refused before any validation started: the first revision check, not only the one before the write
    expect(validation).not.toHaveBeenCalled();
  });

  it("answers conflict, writing nothing, when the file moves while the text is validated (race guard)", async () => {
    await fs.writeFile(file, SAMPLE);
    const { text, revision } = await get();
    const mkdtemp = fs.mkdtemp.bind(fs) as (prefix: string) => Promise<string>;
    const outsideWriter = SAMPLE.replace("m1", "written-by-someone-else");
    vi.spyOn(fs, "mkdtemp").mockImplementation((async (prefix: string) => {
      await fs.writeFile(file, outsideWriter);
      return mkdtemp(prefix);
    }) as never);
    expect(await failureOf(save(text ?? "", revision))).toMatchObject({ code: "conflict" });
    expect(await fs.readFile(file, "utf8")).toBe(outsideWriter);
  });

  it("validates a private copy under the pap home, removes it, and says so when it cannot", async () => {
    await fs.writeFile(file, SAMPLE);
    const { text, revision } = await get();
    const seen: Array<{ dir: string; mode: number }> = [];
    const mkdtemp = fs.mkdtemp.bind(fs) as (prefix: string) => Promise<string>;
    vi.spyOn(fs, "mkdtemp").mockImplementation((async (prefix: string) => {
      const dir = await mkdtemp(prefix);
      seen.push({ dir, mode: (await fs.stat(dir)).mode & 0o777 });
      return dir;
    }) as never);
    await save(text ?? "", revision);
    const folder = join(bed.context().papHome, "models-check");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.dir.startsWith(`${folder}/`)).toBe(true);
    expect(seen[0]?.mode).toBe(0o700);
    expect((await fs.stat(folder)).mode & 0o777).toBe(0o700);
    expect(await fs.readdir(folder)).toEqual([]);

    const events: unknown[] = [];
    const rm = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (path, options) => {
      if (String(path).startsWith(`${folder}/`)) throw new Error("injected");
      return rm(path, options);
    });
    const ctx = { ...bed.context(), emit: (event: unknown) => void events.push(event) };
    await configSave.run({ text: text ?? "", baseRevision: revision, revisionKey: KEY }, ctx);
    expect(events).toContainEqual({ kind: "validation_copy_not_removed", code: "failed" });
  });

  it("answers config_invalid with paths only for text that is not JSON, and writes nothing", async () => {
    await fs.writeFile(file, SAMPLE);
    const { revision } = await get();
    const result = await save(`{"providers": {"mine": {"apiKey": "sk-TYPED-SECRET" "x": 1}}}`, revision);
    expect(result).toMatchObject({ code: "config_invalid" });
    expect((result as { issues: string[] }).issues).toEqual([
      expect.stringMatching(/^line 1, column \d+: invalid JSON$/),
    ]);
    expect(JSON.stringify(result)).not.toContain("sk-TYPED");
    expect(await fs.readFile(file, "utf8")).toBe(SAMPLE);
  });

  it("refuses a block comment, as Pi does", async () => {
    const { revision } = await get();
    expect(await save(`{ /* c */ "providers": {} }`, revision)).toMatchObject({ code: "config_invalid" });
  });

  it("answers config_invalid with the JSON path for a shape that is wrong", async () => {
    const { revision } = await get();
    const result = await save(`{"providers":{"mine":{"models":"x"}}}`, revision);
    expect(result).toEqual({ code: "config_invalid", issues: ["$.providers.mine.models"] });
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("answers config_invalid when Pi itself rejects a file that has the right shape", async () => {
    const { revision } = await get();
    // a provider with models but no API and no base URL: the shape is fine, Pi's loader refuses it
    const text = `{"providers":{"mine":{"apiKey":"sk-IN-A-BAD-FILE","models":[{"id":"m1"}]}}}`;
    const result = await save(text, revision);
    expect(result).toEqual({ code: "config_invalid", issues: ["$"] });
    expect(JSON.stringify(result)).not.toContain("sk-IN-A-BAD-FILE");
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("caps the issues at 20 and reduces every path to plain characters", async () => {
    const { revision } = await get();
    const bad = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`p${i}-sk-\u202e${"x".repeat(100)}`, { models: "x" }]),
    );
    const result = await save(JSON.stringify({ providers: bad }), revision);
    expect(result).toMatchObject({ code: "config_invalid" });
    const issues = (result as { issues: string[] }).issues;
    expect(issues).toHaveLength(20);
    for (const issue of issues) expect(issue).toMatch(/^[\w$.[\]*-]{1,100}$/);
  });

  it("refuses a placeholder the file does not have, with its line and column", async () => {
    await fs.writeFile(file, SAMPLE);
    const { revision } = await get();
    const line = `"providers":{"mine":{"apiKey":"<redacted:7>"}}}`;
    const result = await save(`{\n${line}`, revision);
    expect(result).toEqual({
      code: "config_invalid",
      issues: [`masked_value_moved at line 2, column ${line.indexOf('"<redacted:7>"') + 1}`],
    });
    expect(await fs.readFile(file, "utf8")).toBe(SAMPLE);
  });

  it("refuses a secret moved to another field, so a later read can never show it", async () => {
    await fs.writeFile(file, SAMPLE);
    const { text, revision } = await get();
    const freed = (text ?? "").replace(`"apiKey": "<redacted:0>"`, `"apiKey": "typed"`);
    expect(freed).not.toBe(text);
    for (const moved of [
      freed.replace(`"api": "openai-completions"`, `"api": "<redacted:0>"`),
      freed.replace(`"id": "m1"`, `"id": "m1", "name": "<redacted:0>"`),
      freed.replace("// my provider", `// my provider "<redacted:0>"`),
      freed.replace(`"<redacted:1>"`, `"<redacted:0>"`),
    ]) {
      const result = await save(moved, revision);
      expect(result).toMatchObject({ code: "config_invalid" });
      expect((result as { issues: string[] }).issues[0]).toMatch(
        /^masked_value_moved at line \d+, column \d+$/,
      );
      expect(JSON.stringify(result)).not.toContain(SECRET_MODELS_KEY);
      expect(await fs.readFile(file, "utf8")).toBe(SAMPLE);
    }
  });

  it("replaces a file that does not parse with a whole new content", async () => {
    await fs.writeFile(file, `{"x": {"baseUrl": "https://h" "apiKey": "sk-OLD"}}`);
    const { revision } = await get();
    const fresh = `{"providers":{"mine":{"baseUrl":"http://x/v1","api":"openai-completions","models":[{"id":"m1"}]}}}`;
    expect(await save(fresh, revision)).toMatchObject({ revision: sha(fresh) });
    expect(await fs.readFile(file, "utf8")).toBe(fresh);
  });

  it("refuses a placeholder in a replacement of a file that does not parse, even when its key is at the same path", async () => {
    const rest = `"baseUrl":"http://x/v1","api":"openai-completions","models":[{"id":"m1"}]`;
    await fs.writeFile(file, `{"providers":{"mine":{"apiKey":"sk-OLD" ${rest}}}}`);
    const { revision } = await get();
    const replacement = `{"providers":{"mine":{"apiKey":"<redacted:0>", ${rest}}}}`;
    expect(await save(replacement, revision)).toMatchObject({ code: "config_invalid" });
    await expect(fs.stat(file)).resolves.toBeDefined();
    expect(await fs.readFile(file, "utf8")).toContain("sk-OLD");
    expect(await fs.readFile(file, "utf8")).not.toContain(`"apiKey":"sk-OLD",`);
  });

  it("writes through a link to a dotfiles folder in the home, keeping the link, mode 0600", async () => {
    const real = join(bed.home, "dotfiles", "models.json");
    await fs.mkdir(join(bed.home, "dotfiles"));
    await fs.writeFile(real, SAMPLE, { mode: 0o644 });
    await fs.symlink(real, file);
    const { text, revision } = await get();
    await save((text ?? "").replace("m1", "mm1"), revision);
    expect(await fs.readFile(real, "utf8")).toBe(SAMPLE.replace("m1", "mm1"));
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
    expect((await fs.stat(real)).mode & 0o777).toBe(0o600);
  });

  it("refuses a link outside the agent folder and the home, and writes nothing", async () => {
    const target = join(outside, "models.json");
    await fs.writeFile(target, SAMPLE);
    await fs.symlink(target, file);
    const error = await failureOf(save(`{"providers":{}}`, sha(SAMPLE)));
    expect(error).toMatchObject({ code: "config_path_refused" });
    expect(await fs.readFile(target, "utf8")).toBe(SAMPLE);
    expect(await fs.readdir(outside)).toEqual(["models.json"]);
  });

  it("refuses a dangling link, a folder and a FIFO as the file", async () => {
    await fs.symlink(join(outside, "gone.json"), file);
    expect(await failureOf(save(`{}`, sha("")))).toMatchObject({ code: "config_path_refused" });
    await fs.rm(file);
    await fs.mkdir(file);
    expect(await failureOf(save(`{}`, sha("")))).toMatchObject({ code: "config_path_refused" });
    await fs.rmdir(file);
    execFileSync("mkfifo", [file]);
    const error = await vi.waitFor(() => failureOf(save(`{}`, sha(""))), { timeout: 2000 });
    expect(error).toMatchObject({ code: "config_path_refused" });
  });

  it("refuses a file with another hard link with its own code and keeps both names", async () => {
    await fs.writeFile(file, SAMPLE);
    await fs.link(file, join(bed.agentDir, "models.copy.json"));
    const { text, revision } = await get();
    const error = await failureOf(save((text ?? "").replace("m1", "mm1"), revision));
    expect(error).toMatchObject({ code: "config_hard_link" });
    expect(error?.message).not.toContain(bed.agentDir);
    expect(await fs.readFile(join(bed.agentDir, "models.copy.json"), "utf8")).toBe(SAMPLE);
    expect(await fs.readFile(file, "utf8")).toBe(SAMPLE);
  });

  it("answers ok when only the folder sync after the rename failed", async () => {
    await fs.writeFile(file, SAMPLE);
    const { text, revision } = await get();
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === bed.agentDir) throw Object.assign(new Error("injected"), { code: "EIO" });
      return open(...args);
    });
    const emitted: unknown[] = [];
    const ctx = { ...bed.context(), emit: (event: unknown) => void emitted.push(event) };
    const result = await configSave.run(
      { text: (text ?? "").replace("m1", "mm1"), baseRevision: revision, revisionKey: KEY },
      ctx,
    );
    expect(result).toMatchObject({ revision: sha(SAMPLE.replace("m1", "mm1")) });
    expect(emitted).toEqual([{ kind: "folder_sync_failed", code: "EIO" }]);
  });

  it("never lets a secret reach a result, an error or an event", async () => {
    await fs.writeFile(file, SAMPLE);
    const { text, revision } = await get();
    const emitted: unknown[] = [];
    const ctx = { ...bed.context(), emit: (event: unknown) => void emitted.push(event) };
    const outcomes: unknown[] = [];
    for (const attempt of [
      text ?? "",
      "{ not json " + SECRET_MODELS_KEY,
      (text ?? "").replace("<redacted:0>", "<redacted:9>"),
    ])
      outcomes.push(
        await configSave
          .run({ text: attempt, baseRevision: revision, revisionKey: KEY }, ctx)
          .catch((error: unknown) => error),
      );
    outcomes.push(
      await configSave
        .run({ text: "x", baseRevision: sha("nope"), revisionKey: KEY }, ctx)
        .catch((e: unknown) => e),
    );
    const all = JSON.stringify([outcomes, emitted, outcomes.map(String)]);
    expect(all).not.toContain(SECRET_MODELS_KEY);
    expect(all).not.toContain("org-LITERAL-HEADER");
  });
});

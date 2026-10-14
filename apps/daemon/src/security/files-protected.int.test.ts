import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUTH_KEY,
  type FileBed,
  NOT_FOUND_BODY,
  outcomeOf,
  rawPut,
  startFileBed,
} from "./testing/fixtures.ts";

// Spec C §8.1, class "protected paths" (M8R90, M8R98, M8R100), through the whole daemon with the owner's browser
// session: the names M5 protects ask "Save anyway?", Pi's folders also take the step-up, Pi's own files are refused,
// and a home folder that is a root protects its dot-entries. The tests run in order: the step-up, once given, lasts.
let bed: FileBed;
beforeAll(async () => {
  bed = await startFileBed();
  for (const dir of [join(bed.R, ".vscode"), join(bed.R, ".pi/extensions"), join(bed.agentDir, "extensions")])
    mkdirSync(dir, { recursive: true });
}, 60_000);
afterAll(async () => {
  await bed?.stop();
});

const enc = encodeURIComponent;
const write = (path: string, confirm: boolean, text = "#!/bin/sh\n", baseEtag: string | null = null) =>
  bed.client.call("files.write", {
    path,
    text,
    baseEtag,
    ...(confirm ? { confirmProtected: true as const } : {}),
  });
const put = (path: string, confirm: boolean) =>
  rawPut(
    bed.t.port,
    `/files/raw?path=${enc(path)}&conflict=replace${confirm ? "&confirmProtected=1" : ""}`,
    bed.browser,
    "put body\n",
  );
const jsonCode = (body: string): unknown => (JSON.parse(body) as { error?: { code: string } }).error?.code;

describe("security: protected paths, the owner's browser session", () => {
  it("asks before writing a name M5 protects, writes nothing without the confirmation, and writes with it", async () => {
    const targets = [
      join(bed.R, ".git/hooks/pre-commit"),
      join(bed.R, ".envrc"),
      join(bed.R, ".vscode/tasks.json"),
    ];
    for (const path of targets) {
      expect([path, outcomeOf(await write(path, false))]).toEqual([path, "protected_path"]);
      expect(existsSync(path), path).toBe(false);
    }
    for (const path of targets) {
      expect([path, outcomeOf(await write(path, true))]).toEqual([path, "ok"]);
      expect(readFileSync(path, "utf8"), path).toBe("#!/bin/sh\n");
    }
  });

  it("a folder of Pi's configuration takes the confirmation and a step-up: no step-up, nothing written", async () => {
    const path = join(bed.R, ".pi/extensions/x.ts");
    expect(outcomeOf(await write(path, false))).toBe("protected_path");
    expect(outcomeOf(await write(path, true))).toBe("step_up_required");
    expect(existsSync(path)).toBe(false);
    const agentExtension = join(bed.agentDir, "extensions/e.ts");
    expect(outcomeOf(await write(agentExtension, true))).toBe("step_up_required");
    expect(existsSync(agentExtension)).toBe(false);
  });

  it("answers PUT /files/raw 409, then 403 step_up_required where it applies, and places nothing", async () => {
    const hook = join(bed.R, ".git/hooks/post-commit");
    const refused = await put(hook, false);
    expect([refused.status, jsonCode(refused.body)]).toEqual([409, "protected_path"]);
    expect(existsSync(hook)).toBe(false);
    const pi = join(bed.R, ".pi/extensions/y.ts");
    const piAsk = await put(pi, false);
    expect([piAsk.status, jsonCode(piAsk.body)]).toEqual([409, "protected_path"]);
    const stepUp = await put(pi, true);
    expect([stepUp.status, jsonCode(stepUp.body)]).toEqual([403, "step_up_required"]);
    expect(existsSync(pi)).toBe(false);
    const placed = await put(hook, true);
    expect(placed.status).toBe(200);
    expect(readFileSync(hook, "utf8")).toBe("put body\n");
    // The other protected families through the upload route: asked (409) with the file untouched, then placed.
    const envrc = await put(join(bed.R, ".envrc"), false);
    expect([envrc.status, jsonCode(envrc.body)]).toEqual([409, "protected_path"]);
    expect(readFileSync(join(bed.R, ".envrc"), "utf8")).toBe("#!/bin/sh\n");
    const launch = join(bed.R, ".vscode/launch.json");
    expect((await put(launch, false)).status).toBe(409);
    expect(existsSync(launch)).toBe(false);
    expect((await put(launch, true)).status).toBe(200);
    expect(readFileSync(launch, "utf8")).toBe("put body\n");
    const agentUpload = join(bed.agentDir, "extensions/e2.ts");
    const agentStepUp = await put(agentUpload, true);
    expect([agentStepUp.status, jsonCode(agentStepUp.body)]).toEqual([403, "step_up_required"]);
    expect(existsSync(agentUpload)).toBe(false);
  });

  it("judges the spelling it is given: case variants of protected names are still asked about", async () => {
    mkdirSync(join(bed.R, ".GIT/hooks"), { recursive: true });
    for (const name of [".Envrc", ".GIT/hooks/pre-push"]) {
      const path = join(bed.R, name);
      expect([name, outcomeOf(await write(path, false))]).toEqual([name, "protected_path"]);
      expect(existsSync(path), name).toBe(false);
    }
  });

  it("with the home folder as a root, home's dot-entries ask and the rest of home does not (owner f8)", async () => {
    const rc = join(bed.userHome, ".bashrc");
    const etag = async (path: string): Promise<string> => {
      const read = await bed.client.call("files.read", { path });
      if (!read.ok) throw new Error("read failed");
      return (read.result as { meta: { etag: string } }).meta.etag;
    };
    const before = await etag(rc);
    expect(outcomeOf(await write(rc, false, "# changed\n", before))).toBe("protected_path");
    expect(readFileSync(rc, "utf8")).toBe("# rc\n");
    expect(outcomeOf(await write(rc, true, "# changed\n", before))).toBe("ok");
    expect(readFileSync(rc, "utf8")).toBe("# changed\n");
    const plain = join(bed.userHome, "proj/a.txt");
    expect(outcomeOf(await write(plain, false, "b\n", await etag(plain)))).toBe("ok");
    expect(readFileSync(plain, "utf8")).toBe("b\n");
    // The same two through the upload route.
    const putRc = await put(join(bed.userHome, ".profile"), false);
    expect([putRc.status, jsonCode(putRc.body)]).toEqual([409, "protected_path"]);
    expect(existsSync(join(bed.userHome, ".profile"))).toBe(false);
    expect((await put(join(bed.userHome, ".profile"), true)).status).toBe(200);
    expect((await put(join(bed.userHome, "proj/c.txt"), false)).status).toBe(200);
  });

  it("after the owner's step-up, Pi's folders take the confirmed write", async () => {
    await bed.t.confirmStepUp(bed.cookie);
    const path = join(bed.R, ".pi/extensions/x.ts");
    expect(outcomeOf(await write(path, true))).toBe("ok");
    expect(readFileSync(path, "utf8")).toBe("#!/bin/sh\n");
    const agentExtension = join(bed.agentDir, "extensions/e.ts");
    expect(outcomeOf(await write(agentExtension, true))).toBe("ok");
    expect(readFileSync(agentExtension, "utf8")).toBe("#!/bin/sh\n");
    const viaPut = join(bed.R, ".pi/extensions/y.ts");
    expect((await put(viaPut, true)).status).toBe(200);
    expect(readFileSync(viaPut, "utf8")).toBe("put body\n");
  });

  it("Pi's configuration files stay refused for every intent, even confirmed and stepped up: Settings is their editor", async () => {
    for (const name of ["settings.json", "models.json", "auth.json", "mcp.json", "trust.json"]) {
      const path = join(bed.agentDir, name);
      const before = readFileSync(path, "utf8");
      expect([name, outcomeOf(await write(path, true, "{}", null))]).toEqual([name, "not_found"]);
      expect([name, outcomeOf(await write(path, false, "{}", null))]).toEqual([name, "not_found"]);
      const viaPut = await put(path, true);
      expect([name, viaPut.status, viaPut.body]).toEqual([name, 404, NOT_FOUND_BODY]);
      expect(readFileSync(path, "utf8"), name).toBe(before);
    }
    expect(readFileSync(join(bed.agentDir, "auth.json"), "utf8")).toContain(AUTH_KEY);
  });
});

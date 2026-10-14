import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { TRUST_LIMITS, TrustSetHelperResult, TrustStatus } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HelperContext, HelperOpError } from "../ops.ts";
import { fakeInstallers, installCalls } from "./offline-bed.ts";
import { trustSet, trustSetOp, trustStatus, trustStatusOp } from "./trust.ts";

let root: string;
let home: string;
let agentDir: string;
let papHome: string;
let cwd: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-trust-")));
  home = join(root, "home");
  agentDir = join(home, ".pi", "agent");
  papHome = join(root, "pap");
  cwd = join(home, "work", "proj");
  for (const dir of [agentDir, papHome, join(cwd, ".pi", "extensions"), join(cwd, ".pi", "prompts")])
    mkdirSync(dir, { recursive: true });
  mkdirSync(join(cwd, ".agents", "skills", "s"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "skills", "s", "SKILL.md"), "---\nname: s\n---\n");
  writeFileSync(join(cwd, ".pi", "extensions", "x.ts"), "export default () => {};\n");
  writeFileSync(join(cwd, ".pi", "prompts", "p.md"), "hello\n");
  writeFileSync(join(cwd, ".pi", "SYSTEM.md"), "be brief\n");
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ theme: "SETTING-VALUE-1", shellCommandPrefix: "SETTING-VALUE-2" }),
  );
  writeFileSync(
    join(cwd, ".pi", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        remote: { url: "https://h.example/mcp", headers: { Authorization: "Bearer ENV-VALUE-3" } },
        local: { command: "node", env: { GITHUB_TOKEN: "ENV-VALUE-4" } },
      },
    }),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ctxFor = (
  target: string | null = cwd,
): Pick<HelperContext, "agentDir" | "papHome" | "home" | "cwd"> => ({
  agentDir,
  papHome,
  home,
  ...(target === null ? {} : { cwd: target }),
});
const fullCtx = (target: string = cwd): HelperContext => ({
  ...ctxFor(target),
  papHome,
  signal: new AbortController().signal,
  emit: () => {},
  prompt: async () => null,
});
const trustFile = () =>
  JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf8")) as Record<string, unknown>;
const set = (decision: boolean | null, projects: string[] = []) => trustSet({ decision, projects }, ctxFor());

describe("trust.status: what trusting turns on (M7R107)", () => {
  it("lists the project's servers masked, extensions, skills, templates, setting keys and the system prompt", async () => {
    const status = await trustStatus(ctxFor());
    expect(TrustStatus.safeParse(status).success).toBe(true);
    expect(status).toMatchObject({
      requiresTrust: true,
      decision: null,
      decisionPath: null,
      inherited: false,
    });
    const { resources } = status;
    expect(resources.mcpServers.map((server) => server.name)).toEqual(["remote", "local"]);
    expect(resources.mcpServers.find((server) => server.name === "local")?.envNames).toEqual([
      "GITHUB_TOKEN",
    ]);
    expect(resources.extensions).toEqual(["x.ts"]);
    expect(resources.skills).toEqual(["s"]);
    expect(resources.promptTemplates).toBe(1);
    expect(resources.settingsKeys).toEqual(["theme", "shellCommandPrefix"]);
    expect(resources.systemPrompt).toBe(true);
    expect(resources.truncated).toBe(false);
    expect(resources.unlisted).toEqual([]);
    const text = JSON.stringify(status);
    for (const value of ["ENV-VALUE-3", "ENV-VALUE-4", "SETTING-VALUE-1", "SETTING-VALUE-2"])
      expect(text).not.toContain(value);
  });

  it("reports a folder with nothing to gate as not requiring trust, with nothing listed", async () => {
    const bare = join(home, "bare");
    mkdirSync(bare);
    const status = await trustStatus(ctxFor(bare));
    expect(status.requiresTrust).toBe(false);
    expect(status.resources).toEqual({
      mcpServers: [],
      extensions: [],
      skills: [],
      promptTemplates: 0,
      settingsKeys: [],
      systemPrompt: false,
      truncated: false,
      unlisted: [],
    });
  });

  it("names the decision and the folder that holds it, and says when a parent decided", async () => {
    new ProjectTrustStore(agentDir).set(join(home, "work"), true);
    expect(await trustStatus(ctxFor())).toMatchObject({
      decision: true,
      decisionPath: join(home, "work"),
      inherited: true,
    });
    new ProjectTrustStore(agentDir).set(cwd, false);
    expect(await trustStatus(ctxFor())).toMatchObject({
      decision: false,
      decisionPath: cwd,
      inherited: false,
    });
  });

  it("judges a symlinked spelling by its real path", async () => {
    new ProjectTrustStore(agentDir).set(cwd, true);
    const link = join(root, "link");
    symlinkSync(cwd, link);
    expect(await trustStatus(ctxFor(link))).toMatchObject({
      decision: true,
      decisionPath: cwd,
      inherited: false,
    });
  });

  it("makes a corrupt trust.json a decision of null, and logs the store's error once", async () => {
    writeFileSync(join(agentDir, "trust.json"), "{not json");
    const log = vi.fn();
    const first = await trustStatus(ctxFor(), log);
    expect(first).toMatchObject({ decision: null, decisionPath: null, inherited: false });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("needs a folder that exists", async () => {
    await expect(trustStatus(ctxFor(join(root, "missing")))).rejects.toMatchObject({ code: "bad_params" });
    await expect(trustStatus(ctxFor(null))).rejects.toMatchObject({ code: "bad_params" });
  });
});

describe("trust.status: hostile folders", () => {
  it("lists nothing from an extensions folder that is a link leaving the project", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret-name.ts"), "");
    rmSync(join(cwd, ".pi", "extensions"), { recursive: true });
    symlinkSync(outside, join(cwd, ".pi", "extensions"));
    expect((await trustStatus(ctxFor())).resources.extensions).toEqual([]);
  });

  it("lists no setting key of a settings file that is not an object, is too large or is a link out", async () => {
    const settings = join(cwd, ".pi", "settings.json");
    writeFileSync(settings, "[1,2]");
    expect((await trustStatus(ctxFor())).resources.settingsKeys).toEqual([]);
    writeFileSync(settings, `{"a":"${"x".repeat(1024 * 1024)}"}`);
    expect((await trustStatus(ctxFor())).resources.settingsKeys).toEqual([]);
    rmSync(settings);
    writeFileSync(join(root, "elsewhere.json"), '{"leaked":1}');
    symlinkSync(join(root, "elsewhere.json"), settings);
    expect((await trustStatus(ctxFor())).resources.settingsKeys).toEqual([]);
  });

  it("strips control and bidi characters from names, and clips long ones", async () => {
    writeFileSync(join(cwd, ".pi", "extensions", "a\u202eb\nc.ts"), "");
    writeFileSync(join(cwd, ".pi", "extensions", `${"n".repeat(200)}.ts`), "");
    const { extensions } = (await trustStatus(ctxFor())).resources;
    expect(extensions).toContain("abc.ts");
    expect(
      extensions.every((name) => name.length <= TRUST_LIMITS.name && !/[\p{Cc}\p{Cf}]/u.test(name)),
    ).toBe(true);
  });

  it("caps each list and says so", async () => {
    for (let i = 0; i < TRUST_LIMITS.extensions + 20; i++)
      writeFileSync(join(cwd, ".pi", "extensions", `e${String(i).padStart(3, "0")}.ts`), "");
    const { resources } = await trustStatus(ctxFor());
    expect(resources.extensions).toHaveLength(TRUST_LIMITS.extensions);
    expect(resources.truncated).toBe(true);
  });
});

describe("trust.set (M7R103, M7R104)", () => {
  it("writes the real path of the folder through Pi's store, keys sorted", async () => {
    new ProjectTrustStore(agentDir).set(join(root, "zzz"), false);
    const link = join(root, "link");
    symlinkSync(cwd, link);
    const result = await trustSet({ decision: true, projects: [] }, ctxFor(link));
    expect(TrustSetHelperResult.safeParse(result).success).toBe(true);
    expect(result).toEqual({ ok: true, folder: cwd });
    expect(trustFile()).toEqual({ [cwd]: true, [join(root, "zzz")]: false });
    expect(Object.keys(trustFile())).toEqual([cwd, join(root, "zzz")].sort());
  });

  it("records false, and clearing removes the key", async () => {
    await set(false);
    expect(trustFile()).toEqual({ [cwd]: false });
    await set(null);
    expect(trustFile()).toEqual({});
  });

  it("applies no breadth rule to false or to clearing", async () => {
    expect(await trustSet({ decision: false, projects: [] }, ctxFor(home))).toEqual({
      ok: true,
      folder: home,
    });
    expect(await trustSet({ decision: null, projects: [] }, ctxFor(home))).toEqual({
      ok: true,
      folder: home,
    });
  });

  it("refuses to trust the home folder, a folder above it and a folder holding Pi's agent directory", async () => {
    expect(await trustSet({ decision: true, projects: [] }, ctxFor(home))).toEqual({
      ok: false,
      refusal: "home-or-above",
    });
    expect(await trustSet({ decision: true, projects: [] }, ctxFor(root))).toEqual({
      ok: false,
      refusal: "home-or-above",
    });
    expect(await trustSet({ decision: true, projects: [] }, ctxFor(join(home, ".pi")))).toEqual({
      ok: false,
      refusal: "holds-pi-or-pap",
    });
  });

  it("refuses a folder holding pap's home and a folder holding other known projects, judged by real path", async () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "pap-trust-else-")));
    try {
      const nestedPap = join(elsewhere, "pap");
      mkdirSync(nestedPap);
      const asked = { ...ctxFor(elsewhere), papHome: nestedPap };
      expect(await trustSet({ decision: true, projects: [] }, asked)).toEqual({
        ok: false,
        refusal: "holds-pi-or-pap",
      });
      const a = join(elsewhere, "a");
      const b = join(elsewhere, "b");
      mkdirSync(a);
      mkdirSync(b);
      const viaLink = join(root, "a-link");
      symlinkSync(a, viaLink);
      const workspace = ctxFor(elsewhere);
      expect(await trustSet({ decision: true, projects: [viaLink, b] }, workspace)).toEqual({
        ok: false,
        refusal: "holds-other-projects",
      });
      expect(await trustSet({ decision: true, projects: [viaLink] }, ctxFor(a))).toEqual({
        ok: true,
        folder: a,
      });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("writes nothing when it refuses", async () => {
    await trustSet({ decision: true, projects: [] }, ctxFor(home));
    expect(() => readFileSync(join(agentDir, "trust.json"))).toThrow();
  });

  it("fails closed on a corrupt store, and leaves the file alone", async () => {
    writeFileSync(join(agentDir, "trust.json"), "{not json");
    await expect(set(true)).rejects.toMatchObject({ code: "failed" });
    await expect(set(true)).rejects.toBeInstanceOf(HelperOpError);
    expect(readFileSync(join(agentDir, "trust.json"), "utf8")).toBe("{not json");
  });
});

describe("the operations", () => {
  it("run the same functions with the helper's context", async () => {
    expect(TrustStatus.safeParse(await trustStatusOp.run({}, fullCtx())).success).toBe(true);
    expect(await trustSetOp.run({ decision: true, projects: [] }, fullCtx())).toEqual({
      ok: true,
      folder: cwd,
    });
  });
});

describe("trust.status runs offline (MC52)", () => {
  it("never installs a missing configured package: no npm or git call, the status still answers", async () => {
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:pap-missing-pkg", "git:github.com/o/missing-pkg"] }),
    );
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ packages: ["npm:pap-missing-project-pkg"] }),
    );
    const log = join(root, "installers.log");
    vi.stubEnv("PATH", fakeInstallers(join(root, "bin"), log));
    try {
      expect(TrustStatus.safeParse(await trustStatus(ctxFor())).success).toBe(true);
      expect(installCalls(log)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

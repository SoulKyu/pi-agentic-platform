import { chmodSync, existsSync, lstatSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyPackage,
  type CopyRun,
  isDeniedName,
  literalValuesOf,
  modelsFile,
  parsePackageSource,
  RELAY_BASE,
  SETTINGS_KEYS,
  sanitizeSettings,
  secretValuesOf,
} from "./profile-allowlist.ts";
import { listAll, MARKER, mkfifo, type Scratch, scratch } from "./testing/profile-fixture.ts";

let s: Scratch;
afterEach(() => s?.cleanup());
const run = (): CopyRun => ({ files: 0, bytes: 0, skipped: [] });

describe("isDeniedName", () => {
  it.each([
    ".env",
    ".env.local",
    ".envrc",
    ".npmrc",
    ".netrc",
    "a.pem",
    "A.KEY",
    "id_rsa",
    "id_ed25519",
    "auth.json",
    "my-credentials.json",
    ".credentials.json",
    "x.sqlite",
    "x.db",
    "x.sqlite-wal",
    ".git",
  ])("denies %s", (name) => expect(isDeniedName(name)).toBe(true));
  it.each(["index.js", "package.json", "environment.ts", "keyboard.js", "idea.md", "db.ts", "SKILL.md"])(
    "keeps %s",
    (name) => expect(isDeniedName(name)).toBe(false),
  );
});

describe("copyPackage (RT-18)", () => {
  function pack(): CopyRun {
    s = scratch();
    const src = join(s.root, "pkg");
    s.put("pkg/lib/a.js", "a");
    s.put("pkg/.git/config", `${MARKER}`);
    s.put("pkg/.npmrc", MARKER);
    s.put("pkg/sub/.env", MARKER);
    s.put("outside/leak.txt", `${MARKER}-outside`);
    symlinkSync("lib/a.js", join(src, "link-in"));
    symlinkSync(s.outside, join(src, "link-out"));
    symlinkSync("../../outside/leak.txt", join(src, "lib", "link-file-out"));
    symlinkSync(join(src, ".npmrc"), join(src, "link-to-denied"));
    symlinkSync("missing", join(src, "dangling"));
    mkfifo(join(src, "pipe"));
    const r = run();
    copyPackage(src, join(s.out, "pkg"), r, "pkg");
    return r;
  }

  it("copies what is allowed and drops names, specials and bad links, reporting each", () => {
    const r = pack();
    const rels = listAll(s.out)
      .map((entry) => entry.rel)
      .sort();
    expect(rels).toEqual(["pkg", "pkg/lib", "pkg/lib/a.js", "pkg/link-in", "pkg/sub"]);
    expect(readlinkSync(join(s.out, "pkg/link-in"))).toBe("lib/a.js");
    expect(r.skipped.sort()).toEqual([
      "pkg/.git: name",
      "pkg/.npmrc: name",
      "pkg/dangling: link",
      "pkg/lib/link-file-out: link",
      "pkg/link-out: link",
      "pkg/link-to-denied: link",
      "pkg/pipe: special file",
      "pkg/sub/.env: name",
    ]);
  });

  // Mutant "a link outside the package followed": the copy would hold outside/leak.txt.
  it("never copies the content a link outside the package points at", () => {
    pack();
    expect(listAll(s.out).some((entry) => entry.text?.includes(MARKER))).toBe(false);
    expect(existsSync(join(s.out, "pkg/link-out"))).toBe(false);
    expect(lstatSync(join(s.out, "pkg/link-in")).isSymbolicLink()).toBe(true);
  });

  it("refuses a tree over the file budget", () => {
    s = scratch();
    s.put("pkg/a", "1");
    s.put("pkg/b", "2");
    const r: CopyRun = { files: 0, bytes: 0, skipped: [], maxFiles: 1 };
    expect(() => copyPackage(join(s.root, "pkg"), join(s.out, "pkg"), r, "pkg")).toThrow(/too large/);
  });

  it("refuses a tree over the byte budget", () => {
    s = scratch();
    s.put("pkg/a", "12345");
    const r: CopyRun = { files: 0, bytes: 0, skipped: [], maxBytes: 4 };
    expect(() => copyPackage(join(s.root, "pkg"), join(s.out, "pkg"), r, "pkg")).toThrow(/too large/);
  });

  it("copies the exec bit and a link to the package folder itself", () => {
    s = scratch();
    s.put("pkg/bin/run", "#!/bin/sh\n");
    chmodSync(join(s.root, "pkg/bin/run"), 0o755);
    symlinkSync(".", join(s.root, "pkg/self"));
    copyPackage(join(s.root, "pkg"), join(s.out, "pkg"), run(), "pkg");
    expect(lstatSync(join(s.out, "pkg/bin/run")).mode & 0o777).toBe(0o755);
    expect(readlinkSync(join(s.out, "pkg/self"))).toBe(".");
  });
});

describe("parsePackageSource", () => {
  it.each([
    ["npm:pi-x@1.2.3", { kind: "npm", name: "pi-x", version: "1.2.3" }],
    ["npm:@scope/pi-x@1.2.3", { kind: "npm", name: "@scope/pi-x", version: "1.2.3" }],
    ["npm:pi-x", { kind: "npm", name: "pi-x", version: null }],
    ["npm:../evil", { kind: "unknown" }],
    ["git:github.com/a/b@v1", { kind: "git", host: "github.com", path: "a/b", ref: "v1" }],
    ["https://user:tok@github.com/a/b.git", { kind: "git", host: "github.com", path: "a/b", ref: null }],
    ["git@github.com:a/b.git", { kind: "git", host: "github.com", path: "a/b", ref: null }],
    ["git:github.com/a/../b", { kind: "unknown" }],
    ["../local", { kind: "local", path: "../local" }],
    ["/abs/local", { kind: "local", path: "/abs/local" }],
  ])("%s", (source, expected) => expect(parsePackageSource(source)).toEqual(expected));
});

describe("sanitizeSettings", () => {
  // Mutant "allowlist widened": SETTINGS_KEYS gaining `apiKey` or `theme` keeps them in the output.
  it("keeps only the allowlisted keys", () => {
    const kept = sanitizeSettings({
      theme: "x",
      apiKey: "k",
      compaction: { enabled: true },
      defaultThinkingLevel: "high",
      modelThinkingLevels: { m: "low" },
      enabledModels: ["a/b"],
      defaultProvider: "a",
      defaultModel: "b",
      packages: ["npm:x"],
      skills: ["s"],
      extensions: ["e"],
    });
    expect(Object.keys(kept).sort()).toEqual([
      "compaction",
      "defaultModel",
      "defaultProvider",
      "defaultThinkingLevel",
      "enabledModels",
      "modelThinkingLevels",
    ]);
    expect([...SETTINGS_KEYS].sort()).toEqual(Object.keys(kept).sort());
  });
});

describe("modelsFile (RT-16, RT-18)", () => {
  const source = {
    providers: {
      acme: {
        baseUrl: "https://api.acme.test",
        api: "openai-completions",
        apiKey: "literal-key-value",
        headers: { "x-api-key": "literal-header" },
        models: [
          {
            id: "m1",
            name: "M1",
            headers: { h: "v" },
            contextWindow: 10,
            cost: { input: 1, output: 2 },
            extra: "x",
          },
        ],
      },
      oauthy: { api: "bedrock-converse-stream", models: [] },
      "Bad Name": { api: "openai-completions" },
    },
  };

  // Mutant "headers kept in models.json".
  it("points each provider at the relay, with a placeholder key and no headers", () => {
    const skipped: string[] = [];
    const file = modelsFile(source, ["zed"], skipped);
    expect(file).toEqual({
      providers: {
        acme: {
          baseUrl: `${RELAY_BASE}/acme`,
          api: "openai-completions",
          apiKey: "pap-placeholder",
          models: [{ id: "m1", name: "M1", contextWindow: 10, cost: { input: 1, output: 2 } }],
        },
        zed: { baseUrl: `${RELAY_BASE}/zed`, apiKey: "pap-placeholder" },
      },
    });
    expect(JSON.stringify(file)).not.toContain("header");
    expect(JSON.stringify(file)).not.toContain("literal");
    expect(RELAY_BASE).toBe("http://llm.internal:7842");
    expect(skipped).toEqual(["provider:oauthy: api not served by the relay", "provider:Bad Name: name"]);
  });
});

describe("secretValuesOf (AVM-E30)", () => {
  // Mutant "userinfo test removed": a URL under a harmless key gives nothing.
  it("takes the value and the password of a URL with userinfo under any key", () => {
    expect(secretValuesOf("DATABASE_URL", "postgres://u:secretpass@h/db")).toEqual([
      "postgres://u:secretpass@h/db",
      "secretpass",
    ]);
    expect(secretValuesOf("x", "https://tok-en-0123456789@h/x")).toEqual([
      "https://tok-en-0123456789@h/x",
      "tok-en-0123456789",
    ]);
    expect(secretValuesOf("x", "https://u:p%40ss-word-1@h/x")).toEqual([
      "https://u:p%40ss-word-1@h/x",
      "p%40ss-word-1",
      "p@ss-word-1",
    ]);
  });

  it("takes a credential-named literal as it is, and nothing else", () => {
    expect(secretValuesOf("API_TOKEN", "abcdef-0123")).toEqual(["abcdef-0123"]);
    for (const [key, value] of [
      ["NODE_ENV", "production"],
      ["DATABASE_URL", "postgres://h:5432/db"],
      ["CONTACT", "ops@example.test"],
      ["x", "https://example.test/p?next=a@b"],
      ["API_TOKEN", "$API_TOKEN"],
      ["x", "!pass show db"],
      ["x", "http://${USER}:${PASS}@h/"],
    ] as const)
      expect(secretValuesOf(key, value), `${key}=${value}`).toEqual([]);
  });

  it("reaches a provider header of models.json whatever its name", () => {
    expect(
      literalValuesOf({
        providers: { acme: { headers: { "X-Upstream": "https://u:secretpass@h/x", Accept: "text/plain" } } },
      }),
    ).toEqual(["https://u:secretpass@h/x", "secretpass"]);
  });
});

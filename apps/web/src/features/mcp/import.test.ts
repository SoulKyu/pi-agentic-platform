import { describe, expect, it } from "vitest";
import { IMPORT_LIMITS, normaliseName, parsePaste, previewOf } from "./import.ts";

const names = (text: string) => parsePaste(text).candidates.map((one) => one.name);

describe("parsePaste: JSON shapes", () => {
  const fs = { command: "npx", args: ["-y", "@x/fs"] };

  it("reads { mcpServers: { … } }", () => {
    const got = parsePaste(JSON.stringify({ mcpServers: { fs, docs: { url: "https://d.example/mcp" } } }));
    expect(got.candidates).toEqual([
      { name: "fs", entry: fs },
      { name: "docs", entry: { url: "https://d.example/mcp" } },
    ]);
    expect(got.cut).toBe(false);
  });

  it("reads { <name>: { … } }", () => {
    expect(parsePaste(JSON.stringify({ fs })).candidates).toEqual([{ name: "fs", entry: fs }]);
  });

  it("reads a single entry and names it from the package or the host", () => {
    expect(parsePaste(JSON.stringify(fs)).candidates).toEqual([{ name: "fs", entry: fs }]);
    expect(names(JSON.stringify({ url: "https://mcp.example.com/sse" }))).toEqual(["mcp"]);
  });

  it("skips values that are not a server and keeps the sound ones", () => {
    expect(names(JSON.stringify({ mcpServers: { a: 3, b: fs, c: { note: "x" }, d: [] } }))).toEqual(["b"]);
  });

  it("does not hand a __proto__ key on as a name", () => {
    const text = '{"mcpServers":{"__proto__":{"command":"x"},"constructor":{"command":"y"}}}';
    expect(names(text)).toEqual(["proto", "constructor-server"]);
  });

  it("drops an entry nested deeper than the limit", () => {
    let deep: unknown = { leaf: 1 };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(names(JSON.stringify({ a: { command: "x", extra: deep }, b: fs }))).toEqual(["b"]);
  });
});

describe("parsePaste: command lines and addresses", () => {
  it("turns a command line into a stdio entry named after the package's last segment", () => {
    expect(parsePaste("npx -y @scope/server --flag").candidates).toEqual([
      { name: "server", entry: { command: "npx", args: ["-y", "@scope/server", "--flag"] } },
    ]);
  });

  it("keeps quoted arguments whole", () => {
    expect(parsePaste(`npx -y srv --root "/my files/x" 'a b'`).candidates[0]?.entry).toEqual({
      command: "npx",
      args: ["-y", "srv", "--root", "/my files/x", "a b"],
    });
  });

  it("takes only the part after -- of a claude mcp add line, named by its first word", () => {
    expect(parsePaste("claude mcp add x -- npx y").candidates).toEqual([
      { name: "x", entry: { command: "npx", args: ["y"] } },
    ]);
  });

  it("skips the value of -t / --scope when it looks for the name", () => {
    const got = parsePaste("claude mcp add -t stdio --scope user files -- npx -y srv");
    expect(got.candidates).toEqual([{ name: "files", entry: { command: "npx", args: ["-y", "srv"] } }]);
    expect(got.ignored).toEqual(["-t", "--scope"]);
  });

  it("reads -e and --env into env, in both spellings, and keeps the first = of a value", () => {
    const got = parsePaste("claude mcp add x -e A=1 --env B=x=y --env=C=3 -- npx srv");
    expect(got.candidates[0]?.entry).toEqual({
      command: "npx",
      args: ["srv"],
      env: { A: "1", B: "x=y", C: "3" },
    });
    expect(got.ignored).toEqual([]);
  });

  it("lists every other flag as ignored, whatever its place, and drops an env without a name", () => {
    const got = parsePaste(
      "claude mcp add --transport http -H 'X: y' x -e NOVALUE -e __proto__=1 -- npx srv",
    );
    expect(got.ignored).toEqual(["--transport", "-H", "-e"]);
    expect(got.candidates[0]).toEqual({ name: "x", entry: { command: "npx", args: ["srv"] } });
  });

  it("drops a version from the package name", () => {
    expect(names("npx -y @scope/server@1.2.3")).toEqual(["server"]);
    expect(names("uvx mcp-server-git@latest")).toEqual(["mcp-server-git"]);
  });

  it("keeps any url a pasted JSON holds, http included", () => {
    expect(parsePaste('{"a":{"url":"http://localhost:8080/mcp"}}').candidates).toEqual([
      { name: "a", entry: { url: "http://localhost:8080/mcp" } },
    ]);
  });

  it("turns an https address into an http entry named after the host's first label", () => {
    expect(parsePaste("https://mcp.example.com/v1").candidates).toEqual([
      { name: "mcp", entry: { url: "https://mcp.example.com/v1" } },
    ]);
  });

  it("refuses a plain http address, an unterminated quote and anything else", () => {
    expect(names("http://mcp.example.com/v1")).toEqual([]);
    expect(names(`npx "oops`)).toEqual([]);
  });
});

describe("parsePaste: nothing to import", () => {
  it.each(["", "   ", "hello there, this is not a config", "{ not json", "[1,2]", "null", '{"a":1}', "42"])(
    "answers nothing for %j",
    (text) => {
      expect(parsePaste(text)).toEqual({ candidates: [], cut: false, tooLarge: false, ignored: [] });
    },
  );

  it("refuses a paste over the size limit without parsing it", () => {
    const big = JSON.stringify({ fs: { command: "x", args: ["a".repeat(IMPORT_LIMITS.paste)] } });
    expect(parsePaste(big)).toEqual({ candidates: [], cut: false, tooLarge: true, ignored: [] });
  });

  it("never evaluates what it reads", () => {
    const flag = globalThis as { __pwned?: boolean };
    parsePaste('{"a":{"command":"x","args":["`globalThis.__pwned=true`","$(touch /tmp/x)"]}}');
    parsePaste("npx $(globalThis.__pwned=true)");
    expect(flag.__pwned).toBeUndefined();
  });
});

describe("limits and names", () => {
  it("cuts 300 servers to 200 and says so", () => {
    const servers = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`s${i}`, { command: "x" }]));
    const got = parsePaste(JSON.stringify({ mcpServers: servers }));
    expect(got.candidates).toHaveLength(200);
    expect(got.cut).toBe(true);
  });

  it("normalises names to the schema's alphabet", () => {
    expect(normaliseName("My Server!")).toBe("My-Server");
    expect(normaliseName("  --a..b__")).toBe("a-b");
    expect(normaliseName("é")).toBe("server");
    expect(normaliseName("x".repeat(100))).toHaveLength(64);
  });

  it("makes names unique inside one paste", () => {
    const servers = { "a b": { command: "x" }, "a-b": { command: "y" } };
    expect(names(JSON.stringify({ mcpServers: servers }))).toEqual(["a-b", "a-b-2"]);
  });

  it("treats - and _ as one namespace inside one paste, like the daemon", () => {
    const servers = { "a-b": { command: "x" }, a_b: { command: "y" }, "a b": { command: "z" } };
    expect(names(JSON.stringify({ mcpServers: servers }))).toEqual(["a-b", "a_b-2", "a-b-3"]);
  });
});

describe("previewOf", () => {
  it("masks every env and header value and keeps their names", () => {
    const view = previewOf({
      command: "npx",
      args: ["-y", "srv"],
      env: { API_KEY: "sk-live-123" },
      headers: { Authorization: "Bearer abc" },
    });
    expect(view.env).toEqual([{ name: "API_KEY", value: "•••" }]);
    expect(view.headers).toEqual([{ name: "Authorization", value: "•••" }]);
    expect(JSON.stringify(view)).not.toContain("sk-live-123");
    expect(JSON.stringify(view)).not.toContain("abc");
  });

  it("masks the value after a secret-looking flag and a long token argument", () => {
    const view = previewOf({
      command: "srv",
      args: ["--api-key", "hunter2", "--token=abcdef", "--root", "/tmp", "ghp_" + "a".repeat(30)],
    });
    expect(view.target).toBe("srv --api-key ••• --token=••• --root /tmp •••");
  });

  it("masks credentials and query values of an address", () => {
    const view = previewOf({ url: "https://user:pw@h.example/p?key=secret#x" });
    expect(view.target).toBe("https://•••@h.example/p?•••");
  });

  it("masks userinfo inside arguments, bare or after a flag", () => {
    const view = previewOf({
      command: "srv",
      args: ["postgres://admin:pw@db.example/app", "--dsn=redis://:pw@cache:6379"],
    });
    expect(view.target).toBe("srv postgres://•••@db.example/app --dsn=redis://•••@cache:6379");
  });

  it("masks the value after -H / --header and an inline --header=", () => {
    const view = previewOf({
      command: "srv",
      args: ["-H", "Authorization: Bearer x", "--header", "X-Key: y", "--header=Cookie: z", "-v"],
    });
    expect(view.target).toBe("srv -H ••• --header ••• --header=••• -v");
  });

  it("clips the pairs at 32 and their names at 64, and the target at 500 characters", () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`K${i}`.padEnd(80, "x"), "v"]));
    const view = previewOf({ command: "srv", args: Array.from({ length: 300 }, () => "word"), env: many });
    expect(view.env).toHaveLength(32);
    expect(view.env[0]?.name).toHaveLength(64);
    expect(view.target).toHaveLength(500);
    expect(view.target.endsWith("…")).toBe(true);
  });
});

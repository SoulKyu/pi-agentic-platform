import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonical, entryIsProtected, gateWrite, judgePath, type Scope } from "./boundary.ts";
import { createBoundaryBed } from "../testing/boundary-bed.ts";

let bed: ReturnType<typeof createBoundaryBed>;
beforeEach(() => {
  bed = createBoundaryBed();
});
afterEach(() => bed.dispose());

const scopeOf = (roots: string[], caller: Scope["caller"] = "session", config = bed.config()): Scope => ({
  roots,
  config,
  caller,
});

describe("judgePath inside a project", () => {
  it("accepts a file, with where it leads, its root and no protection", async () => {
    const path = join(bed.proj, "a.txt");
    expect(await judgePath(path, scopeOf([bed.proj]), "read")).toEqual({
      ok: true,
      real: path,
      root: bed.proj,
      protection: "none",
      exists: true,
    });
  });

  it("accepts a new file in an existing folder to write, and calls it missing to read", async () => {
    const path = join(bed.proj, "src", "new.ts");
    expect(await judgePath(path, scopeOf([bed.proj]), "write")).toEqual({
      ok: true,
      real: path,
      root: bed.proj,
      protection: "none",
      exists: false,
    });
    expect(await judgePath(path, scopeOf([bed.proj]), "read")).toEqual({ ok: false, why: "missing" });
  });

  it("calls a new file in a folder that does not exist missing, even to write", async () => {
    const path = join(bed.proj, "nope", "new.ts");
    expect(await judgePath(path, scopeOf([bed.proj]), "write")).toEqual({ ok: false, why: "missing" });
  });

  it("knows the root alone is canonical", () => {
    expect(canonical("/")).toBe(true);
  });
});

describe("protection of a write", () => {
  const protectionOf = async (path: string, roots: string[]) => {
    const judged = await judgePath(path, scopeOf(roots), "write");
    return judged.ok ? judged.protection : judged.why;
  };

  it("asks a confirmation for M5's protected names", async () => {
    expect(await protectionOf(join(bed.proj, ".git", "config"), [bed.proj])).toBe("confirm");
    expect(await protectionOf(join(bed.proj, ".envrc"), [bed.proj])).toBe("confirm");
  });

  it("asks a step-up under a .pi folder and under Pi's directory", async () => {
    expect(await protectionOf(join(bed.proj, ".pi", "settings.json"), [bed.proj])).toBe("step_up");
    expect(await protectionOf(join(bed.agentDir, "extensions", "e.ts"), [bed.home])).toBe("step_up");
  });

  it("asks nothing for an ordinary file", async () => {
    expect(await protectionOf(join(bed.proj, "src", "a.ts"), [bed.proj])).toBe("none");
  });

  it("protects home's dot-entries when a root is the home folder, and only those", async () => {
    expect(await protectionOf(join(bed.home, ".bashrc"), [bed.home])).toBe("confirm");
    expect(await protectionOf(join(bed.home, ".ssh", "id"), [bed.home])).toBe("confirm");
    expect(await protectionOf(join(bed.proj, "a.txt"), [bed.home])).toBe("none");
  });

  it("protects home's dot-entries when a root is above the home folder", async () => {
    expect(await protectionOf(join(bed.home, ".bashrc"), [bed.base])).toBe("confirm");
  });

  it("leaves home's dot-entries outside a project that is not home", async () => {
    expect(await protectionOf(join(bed.home, ".bashrc"), [bed.proj])).toBe("outside");
  });
});

describe("a link between two spellings", () => {
  const hook = () => join(bed.proj, ".git", "hooks", "pre-commit");

  it("takes the stricter protection of the spelling and of where it leads", async () => {
    bed.file(hook());
    bed.link(hook(), join(bed.proj, "notes.txt"));
    bed.link(join(bed.proj, "a.txt"), join(bed.proj, ".pi", "alias"));
    expect(await judgePath(join(bed.proj, "notes.txt"), scopeOf([bed.proj]), "write")).toEqual({
      ok: true,
      real: hook(),
      root: bed.proj,
      protection: "confirm",
      exists: true,
    });
    expect(await judgePath(join(bed.proj, ".pi", "alias"), scopeOf([bed.proj]), "write")).toEqual({
      ok: true,
      real: join(bed.proj, "a.txt"),
      root: bed.proj,
      protection: "step_up",
      exists: true,
    });
  });

  it("gives a token nothing to write through either link", async () => {
    bed.file(hook());
    bed.link(hook(), join(bed.proj, "notes.txt"));
    bed.link(join(bed.proj, "a.txt"), join(bed.proj, ".pi", "alias"));
    const scope = scopeOf([bed.proj], "token");
    for (const name of ["notes.txt", join(".pi", "alias")]) {
      const judged = await judgePath(join(bed.proj, name), scope, "write");
      expect(judged.ok, name).toBe(true);
      if (!judged.ok) continue;
      const gate = gateWrite({
        protection: judged.protection,
        caller: { kind: "token", stepUpUntil: 0 },
        confirmProtected: false,
        now: 1,
      });
      expect(gate, name).toBe("forbidden");
    }
  });

  it("folds the case of a .pi folder", async () => {
    bed.file(join(bed.proj, ".PI", "x"));
    expect(await judgePath(join(bed.proj, ".PI", "x"), scopeOf([bed.proj]), "write")).toEqual({
      ok: true,
      real: join(bed.proj, ".PI", "x"),
      root: bed.proj,
      protection: "step_up",
      exists: true,
    });
  });

  it("says a dangling link is the link itself, judged as a new file", async () => {
    bed.link(join(bed.proj, ".git", "hooks", "post-commit"), join(bed.proj, "dangle"));
    expect(await judgePath(join(bed.proj, "dangle"), scopeOf([bed.proj]), "write")).toEqual({
      ok: true,
      real: join(bed.proj, "dangle"),
      root: bed.proj,
      protection: "none",
      exists: false,
    });
  });
});

describe("a token and the pseudo-filesystems (MC7)", () => {
  const judge = (path: string, caller: Scope["caller"] = "token") =>
    judgePath(path, scopeOf(["/"], caller), "read");

  it("never sees /proc, /sys, /dev, /run nor the runtime folder, as spelled", async () => {
    for (const path of [
      "/proc/self/environ",
      "/proc/1/cmdline",
      "/sys/kernel",
      "/dev/null",
      "/run",
      join(bed.base, "run-user", "bus"),
    ])
      expect(await judge(path), path).toEqual({ ok: false, why: "token_hidden" });
  });

  it("never sees them through a link either", async () => {
    bed.link("/proc/self/environ", join(bed.proj, "env"));
    bed.link("/dev/null", join(bed.proj, "null"));
    bed.link(join(bed.base, "run-user", "bus"), join(bed.proj, "bus"));
    for (const name of ["env", "null", "bus"])
      expect(await judge(join(bed.proj, name)), name).toEqual({ ok: false, why: "token_hidden" });
  });

  it("hides a link spelled under /proc whose target lies elsewhere", async () => {
    expect(await judge("/proc/self/cwd")).toEqual({ ok: false, why: "token_hidden" });
  });

  it("leaves the browser session as it was", async () => {
    const judged = await judge("/proc/self/environ", "session");
    expect(judged.ok).toBe(true);
  });
});

describe("pap's home", () => {
  it("is refused as spelled", async () => {
    const path = join(bed.papHome, "state.db");
    expect(await judgePath(path, scopeOf([bed.home]), "read")).toEqual({ ok: false, why: "pap_home" });
  });

  it("is refused through a link", async () => {
    bed.link(bed.papHome, join(bed.proj, "h"));
    expect(await judgePath(join(bed.proj, "h", "state.db"), scopeOf([bed.proj, bed.home]), "read")).toEqual({
      ok: false,
      why: "pap_home",
    });
  });

  it("opens only the folders the config names, and still refuses the rest", async () => {
    const scope = scopeOf([bed.home], "session", bed.config({ papHomeOpen: ["worktrees"] }));
    const open = join(bed.papHome, "worktrees", "x");
    expect(await judgePath(open, scope, "list")).toEqual({
      ok: true,
      real: open,
      root: bed.home,
      protection: "confirm",
      exists: true,
    });
    expect(await judgePath(join(bed.papHome, "state.db"), scope, "read")).toEqual({
      ok: false,
      why: "pap_home",
    });
  });
});

describe("Pi's private files", () => {
  const privateFiles = ["auth.json", "models.json", "mcp.json", "trust.json", "settings.json"].map((name) =>
    join("agent", name),
  );

  it("are refused for every intent", async () => {
    for (const rel of [...privateFiles, join("agent", "sessions", "x", "a.jsonl")])
      for (const intent of ["list", "read", "write"] as const)
        expect(
          await judgePath(join(bed.home, ".pi", rel), scopeOf([bed.home]), intent),
          `${rel} ${intent}`,
        ).toEqual({ ok: false, why: "pi_private" });
  });

  it("are refused through a link", async () => {
    bed.link(bed.agentDir, join(bed.proj, "pi"));
    for (const name of ["auth.json", "sessions/x/a.jsonl"])
      expect(await judgePath(join(bed.proj, "pi", name), scopeOf([bed.proj, bed.home]), "write")).toEqual({
        ok: false,
        why: "pi_private",
      });
  });
});

describe("a token", () => {
  const judge = (path: string) => judgePath(path, scopeOf([bed.home], "token"), "read");

  it("never sees home's dot-entries, Pi's folder nor an MCP list", async () => {
    for (const path of [
      join(bed.home, ".ssh", "id"),
      join(bed.agentDir, "extensions", "e.ts"),
      join(bed.proj, ".pi", "mcp.json"),
      join(bed.proj, ".mcp.json"),
    ])
      expect(await judge(path), path).toEqual({ ok: false, why: "token_hidden" });
  });

  it("reads an ordinary file", async () => {
    const path = join(bed.proj, "a.txt");
    expect(await judge(path)).toEqual({
      ok: true,
      real: path,
      root: bed.home,
      protection: "none",
      exists: true,
    });
  });

  it("does not hide home's dot-entries when no root is at or above home", async () => {
    const ssh = join(bed.home, ".ssh");
    const path = join(ssh, "id");
    const scope = (caller: Scope["caller"]) => scopeOf([ssh], caller);
    expect(await judgePath(path, scope("token"), "read")).toEqual({
      ok: true,
      real: path,
      root: ssh,
      protection: "none",
      exists: true,
    });
    expect(await judgePath(path, scope("session"), "write")).toEqual({
      ok: true,
      real: path,
      root: ssh,
      protection: "none",
      exists: true,
    });
  });
});

describe("the browser session", () => {
  it("reads a project's .pi/mcp.json (a step-up to write) and .mcp.json", async () => {
    const scope = scopeOf([bed.home]);
    const pi = await judgePath(join(bed.proj, ".pi", "mcp.json"), scope, "read");
    expect(pi.ok && pi.protection).toBe("step_up");
    const mcp = await judgePath(join(bed.proj, ".mcp.json"), scope, "read");
    expect(mcp.ok && mcp.protection).toBe("none");
  });
});

describe("entryIsProtected", () => {
  it("flags pap's home and Pi's sessions for everyone", () => {
    for (const caller of ["session", "token"] as const) {
      expect(entryIsProtected(bed.papHome, scopeOf([bed.home], caller))).toBe(true);
      expect(entryIsProtected(join(bed.agentDir, "sessions"), scopeOf([bed.home], caller))).toBe(true);
    }
  });

  it("flags home's dot-entries for a token only", () => {
    expect(entryIsProtected(join(bed.home, ".ssh"), scopeOf([bed.home], "token"))).toBe(true);
    expect(entryIsProtected(join(bed.home, ".ssh"), scopeOf([bed.home], "session"))).toBe(false);
  });
});

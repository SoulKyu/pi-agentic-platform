import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_FILE_LIMITS } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { type AgentFiles, createAgentFiles } from "./agent-files.ts";

const AGENT = "atlas-0000";
const OTHER = "borea-0001";
const KUBE = ".kube/config";
let root: string;
let secrets: string;
let files: AgentFiles;
let logs: ReturnType<typeof captureLogger>;
const folderOf = (agentId = AGENT): string => join(secrets, "agent-files", agentId);
const bytes = (text: string): Buffer => Buffer.from(text);
const codeOf = (work: () => unknown): string | undefined => {
  try {
    work();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-agent-files-"));
  secrets = join(root, "secrets");
  logs = captureLogger();
  files = createAgentFiles({ secretsDir: secrets, logger: logs.logger });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("put, list and read", () => {
  it("keeps a file 0600 in 0700 folders, and lists its path, size and import date", () => {
    files.put(AGENT, KUBE, bytes("apiVersion: v1"));
    expect(statSync(join(folderOf(), ".kube", "config")).mode & 0o777).toBe(0o600);
    for (const folder of [join(secrets, "agent-files"), folderOf(), join(folderOf(), ".kube")])
      expect(statSync(folder).mode & 0o777, folder).toBe(0o700);
    const listed = files.list(AGENT);
    expect(listed).toEqual([{ path: KUBE, size: 14, importedAt: expect.any(Number) }]);
    expect(Math.abs((listed[0]?.importedAt ?? 0) - Date.now())).toBeLessThan(60_000);
  });

  it("reads every file whole, in path order, and lists another agent's as none", async () => {
    files.put(AGENT, "b.txt", bytes("B"));
    files.put(AGENT, "a/x.json", bytes("{}"));
    expect(await files.read(AGENT)).toEqual([
      { path: "a/x.json", bytes: bytes("{}") },
      { path: "b.txt", bytes: bytes("B") },
    ]);
    expect(files.list(OTHER)).toEqual([]);
    expect(await files.read(OTHER)).toEqual([]);
  });

  it("replaces a file at the same path and the count stays the same", () => {
    files.put(AGENT, KUBE, bytes("one"));
    files.put(AGENT, KUBE, bytes("second"));
    expect(files.list(AGENT).map((entry) => [entry.path, entry.size])).toEqual([[KUBE, 6]]);
    expect(readFileSync(join(folderOf(), ".kube", "config"), "utf8")).toBe("second");
    expect(readdirSync(join(folderOf(), ".kube"))).toEqual(["config"]);
  });

  it("accepts an empty file and one of exactly the limit", () => {
    files.put(AGENT, "empty", Buffer.alloc(0));
    files.put(AGENT, "big", Buffer.alloc(AGENT_FILE_LIMITS.maxBytes));
    expect(files.list(AGENT).map((entry) => entry.size)).toEqual([AGENT_FILE_LIMITS.maxBytes, 0]);
  });

  it("refuses a file of 1_048_577 bytes with payload_too_large and writes nothing", () => {
    expect(codeOf(() => files.put(AGENT, "big", Buffer.alloc(AGENT_FILE_LIMITS.maxBytes + 1)))).toBe(
      "payload_too_large",
    );
    expect(files.list(AGENT)).toEqual([]);
  });

  it("refuses a 33rd file with limit_reached, but still replaces one of the 32", () => {
    for (let n = 0; n < AGENT_FILE_LIMITS.maxFiles; n += 1) files.put(AGENT, `d${n % 4}/f${n}`, bytes("x"));
    expect(codeOf(() => files.put(AGENT, "d0/extra", bytes("x")))).toBe("limit_reached");
    expect(files.list(AGENT)).toHaveLength(32);
    files.put(AGENT, "d0/f0", bytes("replaced"));
    expect(files.list(AGENT)).toHaveLength(32);
    files.put(OTHER, "ok", bytes("x"));
  });

  it("refuses a path outside the rule and an agent id that is not one", () => {
    for (const path of ["../x", "/etc/passwd", "a//b", ".", "a/./b", "a/b/c/d/e/f/g/h/i"])
      expect(
        codeOf(() => files.put(AGENT, path, bytes("x"))),
        path,
      ).toBe("bad_request");
    expect(codeOf(() => files.put("../evil", "x", bytes("x")))).toBe("bad_request");
    expect(existsSync(join(root, "evil"))).toBe(false);
  });

  it("refuses a file where a folder is needed, and a folder where a file is wanted", () => {
    files.put(AGENT, "a", bytes("x"));
    expect(codeOf(() => files.put(AGENT, "a/b", bytes("x")))).toBe("conflict");
    files.put(AGENT, "d/e", bytes("x"));
    expect(codeOf(() => files.put(AGENT, "d", bytes("x")))).toBe("conflict");
    expect(files.list(AGENT).map((entry) => entry.path)).toEqual(["a", "d/e"]);
  });

  it("leaves no temporary file behind and lists none", () => {
    files.put(AGENT, "a", bytes("x"));
    writeFileSync(join(folderOf(), ".~tmp~left"), "partial");
    expect(files.list(AGENT).map((entry) => entry.path)).toEqual(["a"]);
  });
});

describe("links", () => {
  it("refuses a link planted as the agent's folder, and writes nothing through it", () => {
    const target = join(root, "target");
    mkdirSync(target);
    mkdirSync(join(secrets, "agent-files"), { recursive: true, mode: 0o700 });
    symlinkSync(target, folderOf());
    expect(codeOf(() => files.put(AGENT, "x", bytes("secret")))).toBe("internal");
    expect(readdirSync(target)).toEqual([]);
    expect(files.list(AGENT)).toEqual([]);
  });

  it("refuses a link planted as a parent folder of the path", () => {
    const target = join(root, "target");
    mkdirSync(target);
    files.put(AGENT, "x", bytes("1"));
    symlinkSync(target, join(folderOf(), ".kube"));
    expect(codeOf(() => files.put(AGENT, KUBE, bytes("secret")))).toBe("internal");
    expect(readdirSync(target)).toEqual([]);
  });

  it("replaces a link at the file's path instead of writing through it, and never lists or reads one", async () => {
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside-original");
    files.put(AGENT, "real", bytes("r"));
    symlinkSync(outside, join(folderOf(), "link"));
    expect(files.list(AGENT).map((entry) => entry.path)).toEqual(["real"]);
    expect((await files.read(AGENT)).map((entry) => entry.path)).toEqual(["real"]);
    files.put(AGENT, "link", bytes("mine"));
    expect(readFileSync(outside, "utf8")).toBe("outside-original");
    expect(lstatSync(join(folderOf(), "link")).isFile()).toBe(true);
  });

  it("tightens a folder that was made too open", () => {
    files.put(AGENT, "a", bytes("1"));
    chmodSync(folderOf(), 0o755);
    files.put(AGENT, "b", bytes("2"));
    expect(statSync(folderOf()).mode & 0o777).toBe(0o700);
  });
});

describe("remove and pending removals", () => {
  it("removes the file and its empty folders, and remembers the path until it is delivered", () => {
    files.put(AGENT, KUBE, bytes("x"));
    files.put(AGENT, "keep", bytes("y"));
    files.remove(AGENT, KUBE);
    expect(files.list(AGENT).map((entry) => entry.path)).toEqual(["keep"]);
    expect(existsSync(join(folderOf(), ".kube"))).toBe(false);
    expect(files.pendingRemovals(AGENT)).toEqual([KUBE]);
    expect(files.pendingRemovals(OTHER)).toEqual([]);
    files.delivered(AGENT, [KUBE]);
    expect(files.pendingRemovals(AGENT)).toEqual([]);
  });

  it("keeps the pending removals across a new store (a daemon restart), at 0600", () => {
    files.put(AGENT, "a", bytes("x"));
    files.remove(AGENT, "a");
    const again = createAgentFiles({ secretsDir: secrets, logger: logs.logger });
    expect(again.pendingRemovals(AGENT)).toEqual(["a"]);
    const sidecars = readdirSync(join(secrets, "agent-files", ".removals"));
    expect(sidecars).toHaveLength(1);
    expect(statSync(join(secrets, "agent-files", ".removals", sidecars[0] ?? "")).mode & 0o777).toBe(0o600);
  });

  it("forgets a pending removal when the same path is imported again, and delivered ignores unknown paths", () => {
    files.put(AGENT, "a", bytes("x"));
    files.put(AGENT, "b", bytes("x"));
    files.remove(AGENT, "a");
    files.remove(AGENT, "b");
    files.put(AGENT, "a", bytes("again"));
    expect(files.pendingRemovals(AGENT)).toEqual(["b"]);
    files.delivered(AGENT, ["zzz"]);
    expect(files.pendingRemovals(AGENT)).toEqual(["b"]);
  });

  it("keeps the revocation when the pending removal cannot be written: the file stays in the store", () => {
    files.put(AGENT, "a", bytes("x"));
    mkdirSync(join(secrets, "agent-files", ".removals"), { recursive: true });
    chmodSync(join(secrets, "agent-files", ".removals"), 0o500);
    try {
      expect(codeOf(() => files.remove(AGENT, "a"))).toBeDefined();
      expect(files.list(AGENT).map((entry) => entry.path)).toEqual(["a"]);
    } finally {
      chmodSync(join(secrets, "agent-files", ".removals"), 0o700);
    }
  });

  it("is not_found for a file that is not there, and adds no removal for it", () => {
    expect(codeOf(() => files.remove(AGENT, "ghost"))).toBe("not_found");
    expect(files.pendingRemovals(AGENT)).toEqual([]);
  });
});

describe("onChange", () => {
  it("tells the agent after an import and after a removal, and survives a throwing listener", () => {
    const heard = vi.fn();
    files.onChange(() => {
      throw new Error("boom");
    });
    files.onChange(heard);
    files.put(AGENT, "a", bytes("x"));
    files.remove(AGENT, "a");
    expect(heard.mock.calls).toEqual([
      [AGENT, "a"],
      [AGENT, "a"],
    ]);
    expect(codeOf(() => files.remove(AGENT, "a"))).toBe("not_found");
    expect(heard).toHaveBeenCalledTimes(2);
  });
});

describe("trash", () => {
  it("moves the folder and its removals to a trash entry, and purges it", () => {
    files.put(AGENT, KUBE, bytes("x"));
    files.remove(AGENT, KUBE);
    files.put(AGENT, "b", bytes("y"));
    files.dispose(AGENT, 1_700_000_000_000);
    expect(existsSync(folderOf())).toBe(false);
    expect(files.list(AGENT)).toEqual([]);
    expect(files.pendingRemovals(AGENT)).toEqual([]);
    const trash = join(secrets, "agent-files", ".trash");
    expect(readdirSync(trash)).toEqual([`${AGENT}-1700000000000`]);
    expect(statSync(join(trash, `${AGENT}-1700000000000`, "b")).mode & 0o777).toBe(0o600);
    files.purgeTrash(AGENT);
    expect(readdirSync(trash)).toEqual([]);
  });

  it("tells ids that end like a stamp apart: purging release-2024 leaves release-2024-1234", () => {
    for (const id of ["release-2024", "release-2024-1234"]) {
      files.put(id, "a", bytes("x"));
      files.dispose(id, 1_700_000_000_000);
    }
    const trash = join(secrets, "agent-files", ".trash");
    files.purgeTrash("release-2024");
    expect(readdirSync(trash)).toEqual(["release-2024-1234-1700000000000"]);
    files.purgeTrash("release-2024-1234");
    expect(readdirSync(trash)).toEqual([]);
  });

  it("sweeps by the real stamp, not by the digits of an id", () => {
    files.put("release-2024-1234", "a", bytes("x"));
    files.dispose("release-2024-1234", 1_000_000_009_000);
    files.sweepTrash(1_000_000_010_000, 5_000);
    expect(readdirSync(join(secrets, "agent-files", ".trash"))).toEqual(["release-2024-1234-1000000009000"]);
  });

  it("is a no-op for an agent without files, and can be run again", () => {
    files.dispose(AGENT, 1_000_000_000_001);
    files.put(AGENT, "a", bytes("x"));
    files.dispose(AGENT, 1_000_000_000_002);
    files.put(AGENT, "a", bytes("x"));
    files.dispose(AGENT, 1_000_000_000_002);
    expect(readdirSync(join(secrets, "agent-files", ".trash")).sort()).toEqual([
      `${AGENT}-1000000000002`,
      `${AGENT}-1000000000002-1`,
    ]);
  });

  it("sweeps the entries older than the keep time only", () => {
    files.put(AGENT, "a", bytes("x"));
    files.dispose(AGENT, 1_000_000_000_000);
    files.put(OTHER, "a", bytes("x"));
    files.dispose(OTHER, 1_000_000_009_000);
    files.sweepTrash(1_000_000_010_000, 5_000);
    expect(readdirSync(join(secrets, "agent-files", ".trash"))).toEqual([`${OTHER}-1000000009000`]);
  });
});

describe("logs", () => {
  it("never carry a path's content or a message with the content", () => {
    files.put(AGENT, KUBE, bytes("TOPSECRET-CONTENT"));
    files.remove(AGENT, KUBE);
    expect(JSON.stringify(logs.lines)).not.toContain("TOPSECRET-CONTENT");
  });
});

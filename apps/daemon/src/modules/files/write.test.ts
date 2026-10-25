import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { Caller } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createFilesService } from "./service.ts";
import { createFilesBed, type FilesBed } from "./testing/files-bed.ts";

let bed: FilesBed;
let previousUmask: number;
beforeEach(() => {
  bed = createFilesBed();
  previousUmask = process.umask(0o077);
});
afterEach(() => {
  process.umask(previousUmask);
  bed.dispose();
});

const etagOf = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 32);
const service = (roots: string[]) =>
  createFilesService({
    isMember: () => false,
    roots: () => roots,
    boundary: bed.bb.config(),
    deny: bed.deny,
    git: bed.git,
    clock: bed.clock,
    logger: bed.logger,
    readOnly: false,
    workerUmask: 0o022,
  });
type Params = Parameters<ReturnType<typeof service>["write"]>[1];
const save = (roots: string[], caller: Caller, params: Params) => service(roots).write(caller, params);
const code = async (run: Promise<unknown>) =>
  ((await run.catch((e: unknown) => e)) as { code?: string }).code;
const owner = testCaller();
const token = testCaller({ kind: "token" });
const modeOf = (path: string): number => statSync(path).mode & 0o7777;
const written = () => bed.lines.filter((line) => line.msg === "file_written");

describe("creating and replacing", () => {
  it("creates a file with the mode the worker umask gives, the exact content and the etag of it", async () => {
    const path = join(bed.repo, "new.txt");
    const answer = await save([bed.repo], owner, { path, text: "héllo\n", baseEtag: null });
    expect(readFileSync(path, "utf8")).toBe("héllo\n");
    expect(modeOf(path)).toBe(0o644);
    expect(answer.meta).toEqual({
      path,
      size: Buffer.byteLength("héllo\n"),
      mtimeMs: statSync(path).mtimeMs,
      etag: etagOf("héllo\n"),
      binary: false,
      editable: true,
      protection: "none",
    });
    expect(readdirSync(bed.repo).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("answers conflict to a creation when the file exists, and leaves it", async () => {
    const path = join(bed.repo, "a.txt");
    expect(await code(save([bed.repo], owner, { path, text: "new", baseEtag: null }))).toBe("conflict");
    expect(readFileSync(path, "utf8")).toBe("one\n");
  });

  it("replaces a file whose etag matches, and answers conflict to a stale one without touching it", async () => {
    const path = join(bed.repo, "a.txt");
    expect(await code(save([bed.repo], owner, { path, text: "two", baseEtag: etagOf("other") }))).toBe(
      "conflict",
    );
    expect(readFileSync(path, "utf8")).toBe("one\n");
    const answer = await save([bed.repo], owner, { path, text: "two", baseEtag: etagOf("one\n") });
    expect(readFileSync(path, "utf8")).toBe("two");
    expect(answer.meta.etag).toBe(etagOf("two"));
  });

  it("answers conflict when the file to replace is gone", async () => {
    const path = join(bed.repo, "gone.txt");
    expect(await code(save([bed.repo], owner, { path, text: "x", baseEtag: etagOf("x") }))).toBe("conflict");
  });

  it("answers conflict when the file is larger than the editor opens", async () => {
    const path = bed.file(join(bed.repo, "big.txt"), "a".repeat(384 * 1024 + 1));
    const stale = etagOf("a".repeat(384 * 1024 + 1));
    expect(await code(save([bed.repo], owner, { path, text: "x", baseEtag: stale }))).toBe("conflict");
  });

  it("keeps the mode of an existing script", async () => {
    const path = bed.file(join(bed.repo, "run.sh"), "#!/bin/sh\n");
    chmodSync(path, 0o755);
    await save([bed.repo], owner, { path, text: "#!/bin/sh\necho\n", baseEtag: etagOf("#!/bin/sh\n") });
    expect(modeOf(path)).toBe(0o755);
  });

  it("writes through a link inside the root: the target changes and the link stays", async () => {
    const target = bed.file(join(bed.repo, "target.txt"), "t");
    const link = join(bed.repo, "link.txt");
    bed.link(target, link);
    await save([bed.repo], owner, { path: link, text: "changed", baseEtag: etagOf("t") });
    expect(readFileSync(target, "utf8")).toBe("changed");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
  });
});

describe("size limits", () => {
  it("refuses more than 384 KiB of UTF-8 even when it has fewer characters", async () => {
    const text = "é".repeat(196_609);
    expect(text.length).toBeLessThan(384 * 1024);
    expect(Buffer.byteLength(text)).toBe(384 * 1024 + 2);
    const path = join(bed.repo, "big.txt");
    expect(await code(save([bed.repo], owner, { path, text, baseEtag: null }))).toBe("payload_too_large");
    expect(() => statSync(path)).toThrow();
  });

  it("refuses a text whose JSON encoding passes 900 000 bytes: 200 KiB of control characters", async () => {
    const text = "\u0001".repeat(200 * 1024);
    const path = join(bed.repo, "ctl.txt");
    expect(await code(save([bed.repo], owner, { path, text, baseEtag: null }))).toBe("payload_too_large");
    expect(() => statSync(path)).toThrow();
  });
});

describe("the write gate", () => {
  const hook = (): string => join(bed.repo, ".git", "hooks", "pre-commit");

  it("asks for confirmation on a hook, then writes it and logs the protection, never the path", async () => {
    expect(await code(save([bed.repo], owner, { path: hook(), text: "#!/bin/sh\n", baseEtag: null }))).toBe(
      "protected_path",
    );
    expect(() => statSync(hook())).toThrow();
    const answer = await save([bed.repo], owner, {
      path: hook(),
      text: "#!/bin/sh\n",
      baseEtag: null,
      confirmProtected: true,
    });
    expect(answer.meta.protection).toBe("confirm");
    expect(readFileSync(hook(), "utf8")).toBe("#!/bin/sh\n");
    expect(written()).toHaveLength(1);
    expect(written()[0]).toMatchObject({ protection: "confirm", callerKind: "session" });
    expect(JSON.stringify(bed.lines)).not.toContain("pre-commit");
  });

  it("needs a live step-up under .pi/", async () => {
    mkdirSync(join(bed.repo, ".pi", "extensions"), { recursive: true });
    const path = join(bed.repo, ".pi", "extensions", "x.ts");
    const params = { path, text: "export {};\n", baseEtag: null, confirmProtected: true } as const;
    const stale = testCaller({ stepUpUntil: bed.clock.now() - 1 });
    expect(await code(save([bed.repo], stale, params))).toBe("step_up_required");
    expect(() => statSync(path)).toThrow();
    const live = testCaller({ stepUpUntil: bed.clock.now() + 60_000 });
    await save([bed.repo], live, params);
    expect(readFileSync(path, "utf8")).toBe("export {};\n");
    expect(written()[0]).toMatchObject({ protection: "step_up" });
  });

  it("lets a token write an ordinary file", async () => {
    const path = join(bed.repo, "t.txt");
    await save([bed.repo], token, { path, text: "by token", baseEtag: null });
    expect(readFileSync(path, "utf8")).toBe("by token");
    expect(written()[0]).toMatchObject({ protection: "none", callerKind: "token" });
  });

  it("never lets a token write a protected path, confirm, or write under .pi/", async () => {
    const live = testCaller({ kind: "token", stepUpUntil: bed.clock.now() + 60_000 });
    mkdirSync(join(bed.repo, ".pi", "extensions"), { recursive: true });
    const attempts = [
      { path: hook(), text: "x", baseEtag: null },
      { path: hook(), text: "x", baseEtag: null, confirmProtected: true as const },
      { path: join(bed.repo, "plain.txt"), text: "x", baseEtag: null, confirmProtected: true as const },
      { path: join(bed.repo, ".pi", "x"), text: "x", baseEtag: null },
      {
        path: join(bed.repo, ".pi", "extensions", "x.ts"),
        text: "x",
        baseEtag: null,
        confirmProtected: true as const,
      },
    ];
    for (const params of attempts) {
      expect(await code(save([bed.repo], live, params)), JSON.stringify(params)).toBe("forbidden");
      expect(() => statSync(params.path), params.path).toThrow();
    }
    expect(written()).toEqual([]);
  });
});

describe("what the boundary refuses answers not_found", () => {
  it("Pi's settings.json, even with confirmation and a step-up", async () => {
    const live = testCaller({ stepUpUntil: bed.clock.now() + 60_000 });
    const path = join(bed.bb.agentDir, "settings.json");
    const before = readFileSync(path, "utf8");
    expect(
      await code(
        save([bed.bb.home], live, { path, text: "{}", baseEtag: etagOf(before), confirmProtected: true }),
      ),
    ).toBe("not_found");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("a new file in $PAP_HOME, with confirmation", async () => {
    const path = join(bed.bb.papHome, "x");
    expect(
      await code(save([bed.bb.home], owner, { path, text: "x", baseEtag: null, confirmProtected: true })),
    ).toBe("not_found");
    expect(() => statSync(path)).toThrow();
  });

  it("a stale-etag check on a hard link to Pi's auth.json, and a creation over it", async () => {
    const alias = join(bed.bb.proj, "alias.txt");
    linkSync(join(bed.bb.agentDir, "auth.json"), alias);
    const before = readFileSync(alias, "utf8");
    expect(await code(save([bed.bb.proj], owner, { path: alias, text: "x", baseEtag: etagOf(before) }))).toBe(
      "not_found",
    );
    expect(await code(save([bed.bb.proj], owner, { path: alias, text: "x", baseEtag: null }))).toBe(
      "not_found",
    );
    expect(readFileSync(join(bed.bb.agentDir, "auth.json"), "utf8")).toBe(before);
  });

  it("a path outside the caller's roots, and a folder that does not exist", async () => {
    const outside = join(bed.bb.outside, "x.txt");
    expect(await code(save([bed.repo], owner, { path: outside, text: "x", baseEtag: null }))).toBe(
      "not_found",
    );
    const nested = join(bed.repo, "nope", "x.txt");
    expect(await code(save([bed.repo], owner, { path: nested, text: "x", baseEtag: null }))).toBe(
      "not_found",
    );
  });
});

describe("read-only database mode", () => {
  it("refuses a write with read_only and leaves the disk alone", async () => {
    const files = createFilesService({
      isMember: () => false,
      roots: () => [bed.repo],
      boundary: bed.bb.config(),
      deny: bed.deny,
      git: bed.git,
      clock: bed.clock,
      logger: bed.logger,
      readOnly: true,
      workerUmask: 0o022,
    });
    const path = join(bed.repo, "ro.txt");
    expect(await code(files.write(owner, { path, text: "x", baseEtag: null }))).toBe("read_only");
    expect(() => statSync(path)).toThrow();
  });
});

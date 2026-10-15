import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitBed, type GitBed } from "../testing/git-bed.ts";
import { PUSH_SCAN_ARGS } from "./exec.ts";
import { repositoryKeys } from "./repo-scan.ts";

let bed: GitBed;
beforeEach(() => {
  bed = createGitBed();
});
afterEach(() => bed.dispose());

const scan = async (): Promise<string[]> => {
  const out = await bed.runner().run(bed.root, [...PUSH_SCAN_ARGS], { okCodes: [0, 1] });
  return repositoryKeys(out.stdout).sort();
};

describe("repositoryKeys (M9R14) on real scans", () => {
  it("a clean repository reports only pap's own command-scope entry, which is not the repository's", async () => {
    const raw = (
      await bed.runner().run(bed.root, [...PUSH_SCAN_ARGS], { okCodes: [0, 1] })
    ).stdout.toString();
    expect(raw).toContain("command\0");
    expect(await scan()).toEqual([]);
  });

  it("lists the program keys a repository sets, an included file's too", async () => {
    const included = join(bed.dir, "extra.cfg");
    writeFileSync(
      included,
      '[http]\n\tproxy = http://evil.invalid\n[url "https://evil/"]\n\tpushinsteadof = https://github.com/\n',
    );
    bed.git(bed.root, "config", "core.sshcommand", "/bin/false");
    bed.git(bed.root, "config", "remote.origin.receivepack", "/bin/false");
    bed.git(bed.root, "config", "remote.origin.mirror", "true");
    bed.git(bed.root, "config", "credential.https://github.com.helper", "!evil");
    bed.git(bed.root, "config", "include.path", included);
    expect(await scan()).toEqual([
      "core.sshcommand",
      "credential.https://github.com.helper",
      "http.proxy",
      "remote.origin.mirror",
      "remote.origin.receivepack",
      "url.https://evil/.pushinsteadof",
    ]);
  });

  it("does not list the owner's global keys", async () => {
    const runner = bed.runner();
    writeFileSync(
      join(bed.home, ".gitconfig"),
      "[credential]\n\thelper = store\n[http]\n\tproxy = http://p.invalid\n",
    );
    const out = await runner.run(bed.root, [...PUSH_SCAN_ARGS], { okCodes: [0, 1] });
    expect(out.stdout.toString()).toContain("global\0");
    expect(repositoryKeys(out.stdout)).toEqual([]);
  });
});

describe("repositoryKeys on crafted input", () => {
  const entry = (scope: string, key: string, value = "v") => `${scope}\0${key}\n${value}\0`;
  it("skips system, global and command, keeps local, worktree and unknown scopes", () => {
    const text = [
      entry("system", "http.a"),
      entry("global", "http.b"),
      entry("command", "credential.helper", ""),
      entry("local", "http.c"),
      entry("worktree", "http.d"),
      entry("weird", "http.e"),
    ].join("");
    expect(repositoryKeys(Buffer.from(text))).toEqual(["http.c", "http.d", "http.e"]);
  });
  it("an empty scan has no keys", () => {
    expect(repositoryKeys(Buffer.alloc(0))).toEqual([]);
  });
});

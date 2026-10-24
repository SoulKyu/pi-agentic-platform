import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guestGitArgs } from "./git-run.ts";
import { type OpsBed, opsBed } from "./testing.ts";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const TOKEN = "ghs_0123456789abcdefghijklmnopqrstuv";
const TOKEN_OP = { name: "github.token", token: TOKEN, expiresAt: "2026-10-24T13:00:00Z" } as const;
const IDENTITY = {
  name: "github.identity",
  login: "octo",
  displayName: "Octo",
  email: "7+octo@users.noreply.github.com",
} as const;
const TEST_ORIGIN = { PAP_TEST_GITHUB_ORIGIN: "http://127.0.0.1:1" };

let bed: OpsBed;
afterEach(() => bed.clean());

/** A bare repository with one commit on main, beside the bed. */
function bareRepository(at: OpsBed): string {
  const bare = join(at.outside, "origin.git");
  git(at.outside, "init", "-q", "--bare", "-b", "main", bare);
  const seed = join(at.outside, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "hello\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "push", "-q", bare, "main");
  return bare;
}

/** The text of every file below `folder`. */
const textsBelow = (folder: string): string[] =>
  readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));

describe("github ops", () => {
  it("token file is 0600 and on run only", async () => {
    bed = opsBed(undefined, TEST_ORIGIN);
    await bed.value(TOKEN_OP);
    await bed.value(TOKEN_OP);
    const folder = join(bed.run, "pap-github");
    expect(statSync(join(folder, "token")).mode & 0o777).toBe(0o600);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(readdirSync(folder)).toEqual(["token"]);
    expect(readFileSync(join(folder, "token"), "utf8").split("\n")[0]).toBe(TOKEN);
    expect([...textsBelow(bed.home), ...textsBelow(bed.project)].some((text) => text.includes(TOKEN))).toBe(
      false,
    );
    expect(
      git(
        bed.project,
        "config",
        "--file",
        join(bed.home, ".gitconfig"),
        "--get-all",
        "credential.https://github.com.helper",
      ),
    ).toMatch(/^!.*pap-git-credential$/);
  });

  it("the credential helper answers github.com from the file and nothing else", async () => {
    bed = opsBed(undefined, TEST_ORIGIN);
    await bed.value(TOKEN_OP);
    const helper = join(import.meta.dirname, "../../../bin/pap-git-credential");
    const ask = (host: string): string =>
      execFileSync(helper, ["get"], {
        input: `protocol=https\nhost=${host}\n\n`,
        env: { PAP_GUEST_RUN_DIR: bed.run, PATH: GIT_ENV.PATH },
        encoding: "utf8",
      });
    expect(ask("github.com")).toBe(`username=x-access-token\npassword=${TOKEN}\n`);
    expect(ask("evil.example")).toBe("");
    expect(ask("127.0.0.1:1")).toBe("");
  });

  it("identity keeps the private key out of the home, loads it into an agent and sets the signing config", async () => {
    bed = opsBed();
    const first = (await bed.value(IDENTITY)) as { publicKey: string };
    const second = (await bed.value(IDENTITY)) as { publicKey: string };
    expect(first.publicKey).toMatch(/^ssh-ed25519 /);
    expect(second).toEqual(first);
    const key = join(bed.base, ".pap", "signing", "pap_signing");
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(textsBelow(bed.home).some((text) => text.includes("PRIVATE KEY"))).toBe(false);
    expect(readdirSync(join(bed.home, ".ssh"))).toEqual(["pap_signing.pub"]);
    const pub = join(bed.home, ".ssh", "pap_signing.pub");
    const read = (name: string): string =>
      git(bed.project, "config", "--file", join(bed.home, ".gitconfig"), "--get", name);
    expect(read("user.name")).toBe("octo");
    expect(read("user.email")).toBe(IDENTITY.email);
    expect(read("gpg.format")).toBe("ssh");
    expect(read("user.signingkey")).toBe(pub);
    expect(read("gpg.ssh.program")).toMatch(/\/pap-ssh-sign$/);
    expect(read("commit.gpgsign")).toBe("true");
    const socket = join(bed.run, "pap-github", "agent.sock");
    const agentKeys = (): string =>
      execFileSync("ssh-add", ["-L"], {
        env: { PATH: GIT_ENV.PATH, SSH_AUTH_SOCK: socket },
        encoding: "utf8",
      });
    expect(agentKeys()).toContain(first.publicKey.split(" ")[1]);
    await bed.value({ name: "github.forgetKey" });
    expect(() => statSync(key)).toThrow();
    expect(() => statSync(pub)).toThrow();
    expect(() => statSync(socket)).toThrow();
    expect(() => read("commit.gpgsign")).toThrow();
    expect(read("user.email")).toBe(IDENTITY.email);
  });

  it("a session's own signed commit verifies through the agent, and the key never sat in the home", async () => {
    bed = opsBed();
    const { publicKey } = (await bed.value(IDENTITY)) as { publicKey: string };
    git(bed.project, "init", "-q", "-b", "main");
    writeFileSync(join(bed.project, "s.txt"), "s\n");
    const allowed = join(bed.outside, "allowed");
    writeFileSync(allowed, `${IDENTITY.email} ${publicKey}\n`);
    const session = {
      ...GIT_ENV,
      GIT_CONFIG_GLOBAL: join(bed.home, ".gitconfig"),
      PAP_GUEST_RUN_DIR: bed.run,
    };
    const run = (...args: string[]): string =>
      execFileSync("git", args, { cwd: bed.project, env: session, encoding: "utf8" }).trim();
    run("add", "-A");
    run("commit", "-q", "-m", "from a session");
    expect(run("-c", `gpg.ssh.allowedSignersFile=${allowed}`, "log", "-1", "--format=%G?")).toBe("G");
  });

  it("a daemon-initiated commit is signed and verifies against the public key", async () => {
    bed = opsBed();
    const { publicKey } = (await bed.value(IDENTITY)) as { publicKey: string };
    git(bed.project, "init", "-q", "-b", "main");
    writeFileSync(join(bed.project, "d.txt"), "d\n");
    await bed.value({ name: "git.commit", message: "feat: d" });
    const allowed = join(bed.outside, "allowed");
    writeFileSync(allowed, `${IDENTITY.email} ${publicKey}\n`);
    expect(git(bed.project, "-c", `gpg.ssh.allowedSignersFile=${allowed}`, "log", "-1", "--format=%G?")).toBe(
      "G",
    );
  });

  it("identity never writes through a link a session planted in the home", async () => {
    bed = opsBed();
    const victim = join(bed.outside, "victim");
    writeFileSync(victim, "keep\n");
    symlinkSync(victim, join(bed.home, ".gitconfig"));
    await bed.value(IDENTITY);
    expect(readFileSync(victim, "utf8")).toBe("keep\n");
    expect(lstatSync(join(bed.home, ".gitconfig")).isSymbolicLink()).toBe(false);
    expect(git(bed.project, "config", "--file", join(bed.home, ".gitconfig"), "--get", "user.name")).toBe(
      "octo",
    );
    await bed.value({ name: "github.forgetKey" });
    rmSync(join(bed.home, ".ssh"), { recursive: true });
    const folder = join(bed.outside, "elsewhere");
    mkdirSync(folder);
    symlinkSync(folder, join(bed.home, ".ssh"));
    await bed.refusal(IDENTITY);
    expect(readdirSync(folder)).toEqual([]);
  });

  it("the token's helper entries do not follow a planted .gitconfig link either", async () => {
    bed = opsBed(undefined, TEST_ORIGIN);
    const victim = join(bed.outside, "victim");
    writeFileSync(victim, "keep\n");
    symlinkSync(victim, join(bed.home, ".gitconfig"));
    await bed.value(TOKEN_OP);
    expect(readFileSync(victim, "utf8")).toBe("keep\n");
  });

  it("a network call keeps the neutralised command line, with the extra config last and the remote profile", () => {
    const argv = guestGitArgs("/p", ["push"], {
      config: ["credential.helper=", "credential.https://github.com.helper=!/h"],
      remote: { protocols: "https", env: {} },
    });
    expect(argv.indexOf("credential.https://github.com.helper=!/h")).toBe(argv.length - 2);
    expect(argv.at(-1)).toBe("push");
    expect(argv).toContain("core.hooksPath=/dev/null");
    expect(argv).toContain("push.pushOption=");
    expect(argv).not.toContain("protocol.allow=never");
  });

  it("clone refuses a non-empty project", async () => {
    bed = opsBed(undefined, TEST_ORIGIN);
    const bare = bareRepository(bed);
    writeFileSync(join(bed.project, "mine.txt"), "x");
    expect(await bed.refusal({ name: "git.clone", url: `file://${bare}`, upstream: null })).toBe("conflict");
    expect(readdirSync(bed.project)).toEqual(["mine.txt"]);
  });

  it("clone refuses a file url without the test origin", async () => {
    bed = opsBed();
    const bare = bareRepository(bed);
    expect(await bed.refusal({ name: "git.clone", url: `file://${bare}`, upstream: null })).toBe(
      "bad_request",
    );
  });

  it("clone fills an empty project that holds the box's own git init, and sets upstream", async () => {
    bed = opsBed(undefined, TEST_ORIGIN);
    const bare = bareRepository(bed);
    git(bed.project, "init", "-q", "-b", "main");
    const answer = await bed.value({ name: "git.clone", url: `file://${bare}`, upstream: `file://${bare}` });
    expect(answer).toEqual({ branch: "main" });
    expect(readFileSync(join(bed.project, "README.md"), "utf8")).toBe("hello\n");
    expect(git(bed.project, "config", "--get", "remote.upstream.url")).toBe(`file://${bare}`);
  });

  it("a failed clone leaves the project as it was and no clone folder behind", async () => {
    bed = opsBed(undefined, TEST_ORIGIN);
    git(bed.project, "init", "-q", "-b", "main");
    expect(
      await bed.refusal({ name: "git.clone", url: `file://${bed.outside}/missing.git`, upstream: null }),
    ).toBe("failed");
    expect(readdirSync(bed.project)).toEqual([".git"]);
    expect(readdirSync(join(bed.project, "..")).filter((name) => name.startsWith(".clone-"))).toEqual([]);
  });

  it("network ops refuse a repository config that redirects them", async () => {
    bed = opsBed(undefined, TEST_ORIGIN);
    const bare = bareRepository(bed);
    await bed.value({ name: "git.clone", url: `file://${bare}`, upstream: null });
    for (const [key, value] of [
      ["http.proxy", "http://127.0.0.1:9"],
      ["url.https://evil.example/.insteadOf", "https://github.com/"],
      ["credential.helper", "!echo"],
      ["remote.origin.pushurl", "https://evil.example/x.git"],
    ] as const) {
      git(bed.project, "config", key, value);
      expect(await bed.refusal({ name: "git.push" })).toBe("conflict");
      git(bed.project, "config", "--unset-all", key);
    }
    expect(await bed.value({ name: "git.push" })).toEqual({ branch: "main", remote: "origin" });
  });

  it("link and unlink set and remove origin and upstream", async () => {
    bed = opsBed(undefined, TEST_ORIGIN);
    git(bed.project, "init", "-q", "-b", "main");
    await bed.value({ name: "git.link", url: "https://github.com/octo/repo.git" });
    await bed.value({ name: "git.link", url: "https://github.com/octo/other.git" });
    expect(git(bed.project, "remote", "-v").split("\n")).toHaveLength(2);
    expect(git(bed.project, "config", "--get", "remote.origin.url")).toBe(
      "https://github.com/octo/other.git",
    );
    git(bed.project, "remote", "add", "upstream", "https://github.com/up/repo.git");
    await bed.value({ name: "git.unlink" });
    await bed.value({ name: "git.unlink" });
    expect(git(bed.project, "remote")).toBe("");
  });

  it("commit signs and answers null when clean", async () => {
    bed = opsBed();
    await bed.value(IDENTITY);
    git(bed.project, "init", "-q", "-b", "main");
    writeFileSync(join(bed.project, "a.txt"), "one\n");
    const first = (await bed.value({ name: "git.commit", message: "feat: one" })) as { sha: string | null };
    expect(first.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(bed.project, "cat-file", "-p", "HEAD")).toContain("-----BEGIN SSH SIGNATURE-----");
    expect(git(bed.project, "log", "-1", "--format=%an <%ae>")).toBe(`octo <${IDENTITY.email}>`);
    expect(await bed.value({ name: "git.commit", message: "feat: nothing" })).toEqual({ sha: null });
  });

  it("push sets upstream", async () => {
    bed = opsBed(undefined, TEST_ORIGIN);
    const bare = bareRepository(bed);
    await bed.value(IDENTITY);
    await bed.value({ name: "git.clone", url: `file://${bare}`, upstream: null });
    writeFileSync(join(bed.project, "b.txt"), "two\n");
    const { sha } = (await bed.value({ name: "git.commit", message: "feat: two" })) as { sha: string };
    expect(await bed.value({ name: "git.push" })).toEqual({ branch: "main", remote: "origin" });
    expect(git(bed.outside, "--git-dir", bare, "rev-parse", "main")).toBe(sha);
    expect(git(bed.project, "config", "--get", "branch.main.remote")).toBe("origin");
  });
});

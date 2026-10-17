import { copyFileSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanSandboxes, DIGEST, sandbox, type Outcome } from "./container-bed.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrapper = join(repo, "scripts/pap-container.sh");
const archiveWrapper = join(repo, "scripts/build-archive-podman.sh");

afterEach(cleanSandboxes);

const runCall = (outcome: Outcome) => outcome.calls.find((call) => call[0] === "run");
const buildCall = (outcome: Outcome) => outcome.calls.find((call) => call[0] === "build");

const baseRun = (port = "7777") => [
  "run",
  "--detach",
  "--name",
  "pap",
  "--replace",
  "--stop-timeout",
  "40",
  "--user",
  "10001:10001",
  "--userns=keep-id:uid=10001,gid=10001",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--security-opt",
  "systempaths=unconfined",
  "--publish",
  `127.0.0.1:${port}:${port}`,
  "--env",
  `PAP_PORT=${port}`,
  "--volume",
  "pap-data:/home/pap",
  "--",
  "localhost/pap:dev",
];

describe("pap-container.sh run", () => {
  it("calls podman with exactly the measured option set", () => {
    const outcome = sandbox().exec(wrapper, ["run"]);
    expect(outcome.status).toBe(0);
    expect(runCall(outcome)).toEqual(baseRun());
    const text = JSON.stringify(runCall(outcome));
    for (const forbidden of ["--privileged", "--cap-add", "0.0.0.0", "--network"])
      expect(text).not.toContain(forbidden);
  });

  it("says that agents need the flag and prints the doctor command", () => {
    const outcome = sandbox().exec(wrapper, ["run"]);
    expect(outcome.stdout).toContain("started pap on http://localhost:7777");
    expect(outcome.stdout).toContain("doctor --only bwrap");
  });

  it("changes only the port occurrences and the env for --port", () => {
    const outcome = sandbox().exec(wrapper, ["run", "--port", "7792"]);
    expect(runCall(outcome)).toEqual(baseRun("7792"));
  });

  it("honours --name and PAP_IMAGE", () => {
    const outcome = sandbox().exec(wrapper, ["run", "--name", "pap-two"], {
      PAP_IMAGE: "localhost/pap:test",
    });
    const call = runCall(outcome) ?? [];
    expect(call[3]).toBe("pap-two");
    expect(call.at(-1)).toBe("localhost/pap:test");
  });

  it("adds one writable volume per --project", () => {
    const box = sandbox();
    const project = join(box.root, "my.project");
    mkdirSync(project);
    const outcome = box.exec(wrapper, ["run", "--project", project]);
    const expected = baseRun();
    expected.splice(expected.indexOf("--"), 0, "--volume", `${realpathSync(project)}:/work/my.project:rw`);
    expect(runCall(outcome)).toEqual(expected);
  });

  it("mounts the canonical folder when --project is a symlink", () => {
    const box = sandbox();
    const project = join(box.root, "real.project");
    mkdirSync(project);
    symlinkSync(project, join(box.root, "link"));
    const outcome = box.exec(wrapper, ["run", "--project", join(box.root, "link")]);
    const mount = runCall(outcome)?.find((arg) => arg.endsWith(":rw"));
    expect(mount).toBe(`${realpathSync(project)}:/work/real.project:rw`);
  });

  it.each([
    ["the root folder", () => "/"],
    [
      "a symlink to the root folder",
      (root: string) => (symlinkSync("/", join(root, "toroot")), join(root, "toroot")),
    ],
    ["the home folder", (root: string) => root],
    ["an ancestor of the home folder", (root: string) => dirname(root)],
    ["a path ending in ..", (root: string) => (mkdirSync(join(root, "sub")), join(root, "sub", ".."))],
    [
      "a path with a . part",
      (root: string) => (mkdirSync(join(root, "sub", "x"), { recursive: true }), `${join(root, "sub")}/./x`),
    ],
  ])("refuses --project %s", (_label, make) => {
    const box = sandbox();
    const dir = make(box.root);
    const outcome = box.exec(wrapper, ["run", "--project", dir]);
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toMatch(/^pap-container: --project/);
    expect(runCall(outcome)).toBeUndefined();
  });

  it("refuses --project when HOME is empty: the home folder cannot be ruled out, keep-id would make it writable", () => {
    const box = sandbox();
    const project = join(box.root, "proj");
    mkdirSync(project);
    const outcome = box.exec(wrapper, ["run", "--project", project], { HOME: "" });
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toMatch(/^pap-container: --project: HOME is not set/);
    expect(runCall(outcome)).toBeUndefined();
  });

  const refusals: [string, string[], Record<string, string>][] = [
    ["a port below 1024", ["run", "--port", "80"], {}],
    ["a port above 65535", ["run", "--port", "70000"], {}],
    ["a non-numeric port", ["run", "--port", "7x"], {}],
    ["a name with a space", ["run", "--name", "a b"], {}],
    ["a name starting with a dash", ["run", "--name", "-x"], {}],
    ["a relative project", ["run", "--project", "relative/dir"], {}],
    ["a missing project folder", ["run", "--project", "/nonexistent-pap-dir"], {}],
    ["an unknown option", ["run", "--privileged"], {}],
    ["an unknown verb", ["exec"], {}],
    ["the docker runtime", ["run"], { PAP_CONTAINER_RUNTIME: "docker" }],
    ["a podman that is not rootless", ["run"], { FAKE_ROOTLESS: "false" }],
  ];
  it.each(refusals)("refuses %s and never calls podman run", (_label, args, env) => {
    const outcome = sandbox().exec(wrapper, args, env);
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toMatch(/^pap-container: /);
    expect(runCall(outcome)).toBeUndefined();
  });

  it.each([
    ["a space", "with space"],
    ["a dollar sign", "with$dollar"],
    ["a colon", "with:colon"],
  ])("refuses a project folder with %s", (_label, folder) => {
    const box = sandbox();
    const project = join(box.root, folder);
    mkdirSync(project);
    const outcome = box.exec(wrapper, ["run", "--project", project]);
    expect(outcome.status).toBe(1);
    expect(runCall(outcome)).toBeUndefined();
  });

  it("refuses to run as root (guard present, first check)", () => {
    const text = readFileSync(wrapper, "utf8");
    expect(text).toMatch(/\[ "\$\(id -u\)" -ne 0 \] \|\| die "rootful podman is not supported/);
    expect(text.indexOf("id -u")).toBeLessThan(text.indexOf("podman info"));
  });
});

describe("pap-container.sh url", () => {
  const url = "http://localhost:7792/setup#token=Ab1._~-xyz";
  const line = (value: string) => `{"level":"info","msg":"setup_url","url":"${value}"}\n`;

  it("prints only a matching loopback setup URL, the last one", () => {
    const logs = line("http://localhost:7792/setup#token=old") + line(url);
    const outcome = sandbox().exec(wrapper, ["url"], { FAKE_LOGS: logs });
    expect(outcome.stdout).toBe(`${url}\n`);
  });

  it.each([
    ["a remote host", line("http://evil.example:7792/setup#token=abc")],
    ["a token with a shell character", line("http://localhost:7792/setup#token=a;b")],
    ["no line", "plain log\n"],
  ])("answers the no-URL sentence for %s", (_label, logs) => {
    const outcome = sandbox().exec(wrapper, ["url"], { FAKE_LOGS: logs });
    expect(outcome.stdout).toMatch(/^no setup URL: an owner already exists/);
    expect(outcome.stdout).not.toContain("evil");
  });
});

describe("pap-container.sh url (missing container)", () => {
  it("says so instead of exiting silently", () => {
    const outcome = sandbox().exec(wrapper, ["url", "--name", "typo"], { FAKE_NO_CONTAINER: "1" });
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toMatch(/^pap-container: no container named typo/);
    expect(outcome.calls.some((c) => c[0] === "logs")).toBe(false);
  });
});

describe("pap-container.sh build and stop", () => {
  it("passes the base pinned by the digest and labels the image", () => {
    const outcome = sandbox().exec(wrapper, ["build"], { FAKE_DIGEST: DIGEST });
    const call = buildCall(outcome) ?? [];
    expect(call).toContain(`BASE_IMAGE=docker.io/library/node:24-bookworm-slim@${DIGEST}`);
    expect(call).toContain(`org.opencontainers.image.base.digest=${DIGEST}`);
    expect(call.some((arg) => arg.startsWith("org.opencontainers.image.revision="))).toBe(true);
    expect(call).toContain("localhost/pap:dev");
    expect(call[call.indexOf("--format") + 1]).toBe("docker");
    expect(outcome.calls.find((c) => c[0] === "pull")).toBeDefined();
  });

  it.each([
    ["a short digest", "sha256:abc"],
    ["an empty digest", ""],
    ["a non-hex digest", `sha256:${"zz".repeat(32)}`],
  ])("refuses %s", (_label, digest) => {
    const outcome = sandbox().exec(wrapper, ["build"], { FAKE_DIGEST: digest });
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("cannot read the digest");
    expect(buildCall(outcome)).toBeUndefined();
  });

  it("stops with a 40 second grace", () => {
    const outcome = sandbox().exec(wrapper, ["stop", "--name", "pap-two"]);
    expect(outcome.calls.at(-1)).toEqual(["stop", "--time", "40", "--", "pap-two"]);
  });
});

describe("build-archive-podman.sh", () => {
  /** A copy of the script inside a fake repository, so its `.git` check can be exercised. */
  const box = (git: "dir" | "file" = "dir") => {
    const sb = sandbox();
    const fake = join(sb.root, "repo");
    mkdirSync(join(fake, "scripts"), { recursive: true });
    copyFileSync(archiveWrapper, join(fake, "scripts/build-archive-podman.sh"));
    if (git === "dir") mkdirSync(join(fake, ".git"));
    else writeFileSync(join(fake, ".git"), "gitdir: /elsewhere\n");
    const tarball = join(sb.root, "node.tar.xz");
    writeFileSync(tarball, "x");
    const script = join(fake, "scripts/build-archive-podman.sh");
    return { ...sb, fake: realpathSync(fake), script, tarball, out: join(sb.root, "out") };
  };
  const runOf = (outcome: Outcome) => outcome.calls.find((c) => c[0] === "run") ?? [];

  it("builds in ubuntu:22.04 with a read-only source, one writable output and the recipe", () => {
    const sb = box();
    const outcome = sb.exec(sb.script, ["--node-tarball", sb.tarball, "--out", sb.out]);
    expect(outcome.status).toBe(0);
    const call = runOf(outcome);
    expect(call).toContain("docker.io/library/ubuntu:22.04");
    expect(call).toContain(`${sb.fake}:/src:ro`);
    expect(call).toContain(`${sb.out}:/out:rw`);
    expect(call).toContain(`${sb.tarball}:/node.tar.xz:ro`);
    const text = JSON.stringify(call);
    for (const forbidden of ["--privileged", "--cap-add", "--network"]) expect(text).not.toContain(forbidden);
    expect(call.at(-1)).toContain(
      "pnpm install --frozen-lockfile && pnpm build && pnpm build:archive --allow-dirty",
    );
  });

  it("refuses a linked worktree (a .git file) before it runs podman", () => {
    const sb = box("file");
    const outcome = sb.exec(sb.script, ["--node-tarball", sb.tarball, "--out", sb.out]);
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toMatch(/^build-archive-podman: needs a normal clone/);
    expect(runOf(outcome)).toEqual([]);
  });

  it("validates the repository path even when --out is given", () => {
    const sb = sandbox();
    const odd = join(sb.root, "re po");
    mkdirSync(join(odd, "scripts"), { recursive: true });
    mkdirSync(join(odd, ".git"));
    copyFileSync(archiveWrapper, join(odd, "scripts/build-archive-podman.sh"));
    const tarball = join(sb.root, "node.tar.xz");
    writeFileSync(tarball, "x");
    const outcome = sb.exec(join(odd, "scripts/build-archive-podman.sh"), [
      "--node-tarball",
      tarball,
      "--out",
      join(sb.root, "out"),
    ]);
    expect(outcome.status).toBe(1);
    expect(runOf(outcome)).toEqual([]);
  });

  it("pins the image by digest when --image-digest is given, and refuses a bad digest", () => {
    const sb = box();
    const base = ["--node-tarball", sb.tarball, "--out", sb.out];
    const ok = sb.exec(sb.script, [...base, "--image-digest", DIGEST]);
    expect(runOf(ok)).toContain(`docker.io/library/ubuntu:22.04@${DIGEST}`);
    const bad = sb.exec(sb.script, [...base, "--image-digest", "sha256:abc"]);
    expect(bad.status).toBe(1);
    expect(bad.calls.filter((c) => c[0] === "run")).toHaveLength(1);
  });

  it("accepts --image and refuses a weird image, a missing tarball and an unknown option", () => {
    const sb = box();
    const ok = sb.exec(sb.script, ["--node-tarball", sb.tarball, "--out", sb.out, "--image", "ubuntu:20.04"]);
    expect(runOf(ok)).toContain("ubuntu:20.04");
    for (const args of [
      ["--node-tarball", sb.tarball, "--out", sb.out, "--image", "a b;c"],
      ["--out", sb.out],
      ["--node-tarball", join(sb.root, "missing"), "--out", sb.out],
      ["--node-tarball", sb.tarball, "--out", sb.out, "--bogus"],
    ]) {
      const bad = sb.exec(sb.script, args);
      expect(bad.status).toBe(1);
    }
  });
});

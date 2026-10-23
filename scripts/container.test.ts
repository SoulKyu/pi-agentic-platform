import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repo, file), "utf8");
const containerfile = read("Containerfile");
const archiveWrapper = join(repo, "scripts/build-archive-podman.sh");
const archiveScript = readFileSync(archiveWrapper, "utf8");

const stages = containerfile.split(/^FROM /m).slice(1);
const finalStage = stages.at(-1) ?? "";
const buildStage = stages[0] ?? "";
const instructions = (text: string) => text.replace(/\\\n/g, " ").split("\n");

describe("Containerfile", () => {
  it("has a build stage and a final stage", () => {
    expect(stages).toHaveLength(2);
    expect(buildStage).toMatch(/AS build/);
  });

  it("runs the final stage as the numeric uid 10001, last", () => {
    const users = instructions(finalStage).filter((line) => line.startsWith("USER "));
    expect(users).toEqual(["USER 10001:10001"]);
  });

  it("names no secret-looking ARG or ENV", () => {
    const names = instructions(containerfile)
      .filter((line) => /^(ARG|ENV) /.test(line))
      .flatMap((line) => [
        ...line.replace(/^(ARG|ENV) /, "").matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)(?==|\s|$)/g),
      ])
      .map((match) => match[1] ?? "");
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => /(TOKEN|SECRET|PASSWORD|KEY)/i.test(name))).toEqual([]);
  });

  it("copies only /stage from the build stage and never the source", () => {
    const fromBuild = instructions(finalStage).filter(
      (line) => line.startsWith("COPY ") && line.includes("--from"),
    );
    expect(fromBuild).toHaveLength(1);
    expect(fromBuild[0]).toMatch(/--from=build .*\/pap-image-build\/stage \/opt\/pap$/);
    expect(instructions(finalStage).filter((line) => /^ADD /.test(line))).toEqual([]);
    expect(instructions(finalStage).filter((line) => /--mount\S*from=/.test(line))).toEqual([]);
    expect(instructions(finalStage).some((line) => /^COPY (--\S+ )*\. /.test(line))).toBe(false);
    expect(finalStage).not.toMatch(/npmrc/);
  });

  it("installs tini and python3, no bubblewrap and no toolchain in the final stage", () => {
    const apt = instructions(finalStage).find((line) => line.includes("apt-get install")) ?? "";
    for (const pkg of ["tini", "python3"]) expect(apt).toMatch(new RegExp(`\\b${pkg}\\b`));
    expect(apt).not.toContain("bubblewrap");
    for (const pkg of ["g++", "make", "pnpm", "corepack", "build-essential"])
      expect(finalStage).not.toContain(pkg);
  });

  it("has a healthcheck and an exec-form entrypoint through tini", () => {
    expect(finalStage).toMatch(/^HEALTHCHECK /m);
    expect(finalStage).toMatch(/^ENTRYPOINT \["\/usr\/bin\/tini", "--", "\/opt\/pap\/entrypoint\.sh"\]$/m);
  });

  it("sets the worker scope off and drops no file mode on the entrypoint", () => {
    expect(finalStage).toMatch(/PAP_WORKER_SCOPE=off/);
    expect(finalStage).toMatch(/COPY --chown=root:root --chmod=0755 scripts\/container-entrypoint\.sh /);
  });
});

const sourceFiles = (): string[] =>
  ["apps", "packages"].flatMap((parent) =>
    readdirSync(join(repo, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const src = join(repo, parent, entry.name, "src");
        return readdirSync(src, { recursive: true, withFileTypes: true })
          .filter((file) => file.isFile())
          .map((file) => join(file.parentPath, file.name));
      }),
  );

describe("build roots (the stage-path guard must not match pap's own code)", () => {
  const imageRoots = () => ({
    home: /^ENV HOME=(\S+)/m.exec(buildStage)?.[1],
    workdir: /^WORKDIR (\S+)/m.exec(buildStage)?.[1],
    out: /stage-app\.ts --out (\S+)/.exec(buildStage)?.[1],
  });
  const archiveRoots = () => ({
    home: /export HOME=(\S+)/.exec(archiveScript)?.[1],
    copy: /cd (\/pap-archive-build\S*)/.exec(archiveScript)?.[1],
  });

  it("uses dedicated roots in the image build stage and in the archive recipe", () => {
    expect(imageRoots()).toEqual({
      home: "/pap-image-build",
      workdir: "/pap-image-build/src",
      out: "/pap-image-build/stage",
    });
    expect(archiveRoots()).toEqual({ home: "/pap-archive-build", copy: "/pap-archive-build/src" });
  });

  it("finds none of those roots in any compiled source (apps/*/src, packages/*/src)", () => {
    const needles = [...Object.values(imageRoots()), ...Object.values(archiveRoots())].filter(
      (value): value is string => typeof value === "string" && value.length > 1,
    );
    expect(needles.length).toBe(5);
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    const hits = files.filter((file) => {
      const text = readFileSync(file, "utf8");
      return needles.some((needle) => text.includes(needle));
    });
    expect(hits).toEqual([]);
  });
});

describe(".containerignore", () => {
  it("keeps history, worktrees, ledgers, env files and keys out of the build context", () => {
    const lines = read(".containerignore").split("\n");
    for (const entry of [
      ".git",
      ".worktrees",
      ".superpowers",
      "**/.env",
      "**/.env.*",
      "**/*.pem",
      "**/*.key",
      "e2e/.state",
      "coverage",
      "test-results",
      "playwright-report",
      "**/*.tsbuildinfo",
    ]) {
      expect(lines).toContain(entry);
    }
  });
});

describe("entrypoint", () => {
  const entrypoint = read("scripts/container-entrypoint.sh");

  it("parses, then execs the daemon with no sandbox probe", () => {
    execFileSync("sh", ["-n", join(repo, "scripts/container-entrypoint.sh")]);
    expect(entrypoint).toMatch(/^set -eu$/m);
    expect(entrypoint).not.toContain("doctor");
    expect(entrypoint).toMatch(/^exec node .* serve --host 0\.0\.0\.0 --port "\$\{PAP_PORT:-7777\}"$/m);
  });
});

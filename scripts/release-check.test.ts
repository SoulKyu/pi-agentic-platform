import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRelease, releaseTag } from "./release-check.ts";

const REPO = resolve(import.meta.dirname, "..");
const FILES = [
  "package.json",
  "apps/daemon/package.json",
  ".release-please-manifest.json",
  "release-please-config.json",
  ".github/workflows/release.yml",
];
const EXPECTED_CONFIG = {
  $schema: "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "release-type": "node",
  "bump-minor-pre-major": true,
  "bump-patch-for-minor-pre-major": false,
  "include-component-in-tag": false,
  packages: {
    ".": {
      "package-name": "pap",
      "changelog-path": "CHANGELOG.md",
      "extra-files": [{ type: "json", path: "apps/daemon/package.json", jsonpath: "$.version" }],
    },
  },
};

let copy: string;
const edit = (file: string, change: (text: string) => string) => {
  const path = join(copy, file);
  writeFileSync(path, change(readFileSync(path, "utf8")));
};

beforeEach(() => {
  copy = mkdtempSync(join(tmpdir(), "pap-release-check-"));
  for (const file of FILES) {
    mkdirSync(dirname(join(copy, file)), { recursive: true });
    cpSync(join(REPO, file), join(copy, file));
  }
});
afterEach(() => rmSync(copy, { recursive: true, force: true }));

describe("the repository", () => {
  it("passes every release check", () => {
    expect(checkRelease(REPO)).toEqual([]);
  });

  it("pins the release-please configuration key for key", () => {
    expect(JSON.parse(readFileSync(join(REPO, "release-please-config.json"), "utf8"))).toStrictEqual(
      EXPECTED_CONFIG,
    );
    expect(JSON.parse(readFileSync(join(REPO, ".release-please-manifest.json"), "utf8"))).toStrictEqual({
      ".": "0.0.0",
    });
  });
});

describe("version triple", () => {
  it("makes the tag v + version and refuses a version that is not x.y.z", () => {
    expect(releaseTag("1.2.3")).toBe("v1.2.3");
    expect(() => releaseTag("1.2")).toThrow(/version/);
    expect(() => releaseTag("v1.2.3")).toThrow(/version/);
  });

  it.each([
    ["package.json", (t: string) => t.replace('"version": "0.0.0"', '"version": "0.0.1"')],
    ["apps/daemon/package.json", (t: string) => t.replace('"version": "0.0.0"', '"version": "0.0.2"')],
    [".release-please-manifest.json", (t: string) => t.replace("0.0.0", "0.0.3")],
  ])("fails naming %s when it is the one that differs", (file, change) => {
    edit(file, change);
    const problems = checkRelease(copy);
    expect(problems.some((p) => p.includes(file) && p.includes("version"))).toBe(true);
  });

  it("fails when the root has no version", () => {
    edit("package.json", (t) => t.replace(/\s*"version": "0.0.0",/, ""));
    expect(checkRelease(copy).join("\n")).toContain("package.json");
  });
});

describe("configuration", () => {
  it("fails naming the file when a key differs or is added", () => {
    edit("release-please-config.json", (t) =>
      t.replace('"bump-minor-pre-major": true', '"bump-minor-pre-major": false'),
    );
    expect(checkRelease(copy).join("\n")).toContain("release-please-config.json");
    edit("release-please-config.json", (t) => t.replace('"release-type"', '"extra": 1, "release-type"'));
    expect(checkRelease(copy).join("\n")).toContain("release-please-config.json");
  });

  it("fails on unreadable JSON instead of throwing", () => {
    edit("release-please-config.json", () => "{");
    expect(checkRelease(copy).join("\n")).toContain("release-please-config.json");
  });
});

describe("workflow", () => {
  it.each(["push", "pull_request", "schedule", "workflow_run", "pull_request_target"])(
    "fails when a %s trigger is added",
    (trigger) => {
      edit(".github/workflows/release.yml", (t) => t.replace("on:\n", `on:\n  ${trigger}:\n`));
      expect(checkRelease(copy).join("\n")).toContain(trigger);
    },
  );

  it("fails on a push trigger written in the flow form", () => {
    edit(".github/workflows/release.yml", (t) =>
      t.replace(/on:\n {2}workflow_dispatch:[\s\S]*?permissions:/, "on: [push]\npermissions:"),
    );
    expect(checkRelease(copy).join("\n")).toContain("push");
  });

  it("fails on an action not pinned by a 40 hex commit", () => {
    edit(".github/workflows/release.yml", (t) =>
      t.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v7"),
    );
    expect(checkRelease(copy).join("\n")).toContain("actions/checkout@v7");
  });

  it("fails on any secret other than GITHUB_TOKEN", () => {
    edit(".github/workflows/release.yml", (t) => t.replace("secrets.GITHUB_TOKEN", "secrets.NPM_TOKEN"));
    expect(checkRelease(copy).join("\n")).toContain("NPM_TOKEN");
  });

  it("fails on wider top-level permissions and on credentials left in the checkout", () => {
    edit(".github/workflows/release.yml", (t) =>
      t.replace("permissions:\n  contents: read\njobs", "permissions:\n  contents: write\njobs"),
    );
    expect(checkRelease(copy).join("\n")).toContain("permissions");
    edit(".github/workflows/release.yml", (t) =>
      t.replaceAll("persist-credentials: false", "persist-credentials: true"),
    );
    expect(checkRelease(copy).join("\n")).toContain("persist-credentials");
  });

  it("fails when a job loses the main-ref guard", () => {
    for (const job of ["stable", "next"]) {
      edit(".github/workflows/release.yml", (t) =>
        t.replace(new RegExp(`(  ${job}:\\n    if: )github\\.ref == 'refs/heads/main' && `), "$1"),
      );
      expect(checkRelease(copy).join("\n")).toContain(`job ${job}`);
      expect(checkRelease(copy).join("\n")).toContain("refs/heads/main");
      cpSync(join(REPO, ".github/workflows/release.yml"), join(copy, ".github/workflows/release.yml"));
    }
  });

  it("fails when the main-ref guard is only an or-branch of the condition", () => {
    edit(".github/workflows/release.yml", (t) =>
      t.replace(
        "github.ref == 'refs/heads/main' && inputs.channel == 'next'",
        "inputs.channel == 'next' || github.ref == 'refs/heads/main'",
      ),
    );
    expect(checkRelease(copy).join("\n")).toContain("job next");
  });

  it("fails when the next job has no concurrency group", () => {
    edit(".github/workflows/release.yml", (t) => t.replace(/ {4}concurrency:\n.*\n.*\n/, ""));
    expect(checkRelease(copy).join("\n")).toContain("concurrency");
  });

  it("fails when a job asks for more permissions than the pinned set", () => {
    edit(".github/workflows/release.yml", (t) =>
      t.replace(
        "    permissions:\n      contents: write\n    steps:",
        "    permissions:\n      contents: write\n      id-token: write\n    steps:",
      ),
    );
    expect(checkRelease(copy).join("\n")).toContain("job next permissions");
    cpSync(join(REPO, ".github/workflows/release.yml"), join(copy, ".github/workflows/release.yml"));
    edit(".github/workflows/release.yml", (t) => t.replace("      issues: write\n", ""));
    expect(checkRelease(copy).join("\n")).toContain("job stable permissions");
  });

  it.each(["${{ secrets['NPM_TOKEN'] }}", "${{ toJSON(secrets) }}", "${{ secrets }}"])(
    "fails on the secret reference %s that the dotted pattern misses",
    (reference) => {
      edit(".github/workflows/release.yml", (t) => t.replace("${{ secrets.GITHUB_TOKEN }}", reference));
      expect(checkRelease(copy).join("\n")).toContain("secret");
    },
  );

  it.each(["${{ github.event.inputs.channel }}", "${{ github.head_ref }}", "${{ inputs.channel }}"])(
    "fails on %s written inside a run: script (use env:)",
    (expression) => {
      edit(".github/workflows/release.yml", (t) =>
        t.replace("- run: pnpm build\n      - env:", `- run: echo ${expression}\n      - env:`),
      );
      expect(checkRelease(copy).join("\n")).toContain("run:");
    },
  );
});

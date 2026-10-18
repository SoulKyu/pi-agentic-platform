import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRelease } from "./release-check.ts";

const REPO = resolve(import.meta.dirname, "..");
const FILES = [
  "package.json",
  "apps/daemon/package.json",
  ".release-please-manifest.json",
  "release-please-config.json",
  ".github/workflows/release.yml",
  ".github/workflows/pi-compat.yml",
];
const WORKFLOW = ".github/workflows/release.yml";
const PI_COMPAT = ".github/workflows/pi-compat.yml";
const AFFERO =
  "                    GNU AFFERO GENERAL PUBLIC LICENSE\n                       Version 3, 19 November 2007\n";

let copy: string;
const put = (file: string, text: string) => {
  mkdirSync(dirname(join(copy, file)), { recursive: true });
  writeFileSync(join(copy, file), text);
};
const edit = (file: string, change: (text: string) => string) =>
  put(file, change(readFileSync(join(copy, file), "utf8")));
const setLicense = (file: string, id: string | undefined) =>
  edit(file, (text) => {
    const json = JSON.parse(text) as Record<string, unknown>;
    if (id === undefined) delete json.license;
    else json.license = id;
    return JSON.stringify(json, null, 2);
  });
const licensed = (id: string) => {
  setLicense("package.json", id);
  setLicense("apps/daemon/package.json", id);
  put("LICENSE", AFFERO);
  put("LICENSES/Apache-2.0.txt", "Apache License\n");
  put("THIRD_PARTY_NOTICES.md", "reproduced in full in `LICENSES/Apache-2.0.txt`.\n");
};
const flipped = () => {
  edit(PI_COMPAT, (t) => t.replace("on:\n", 'on:\n  schedule:\n    - cron: "17 3 * * *"\n'));
  flippedRelease();
};
const flippedRelease = () =>
  edit(WORKFLOW, (t) =>
    t
      .replace("on:\n  workflow_dispatch:", "on:\n  push:\n    branches: [main]\n  workflow_dispatch:")
      .replace("inputs.channel == 'stable'", "(github.event_name == 'push' || inputs.channel == 'stable')"),
  );
const read = (file: string) => readFileSync(join(copy, file), "utf8");
const problems = () => checkRelease(copy).join("\n");

beforeEach(() => {
  copy = mkdtempSync(join(tmpdir(), "pap-release-v1-"));
  for (const file of FILES) {
    mkdirSync(dirname(join(copy, file)), { recursive: true });
    cpSync(join(REPO, file), join(copy, file));
  }
  // The repository carries its AGPL licence now; these tests start from the unlicensed state they describe.
  setLicense("package.json", "UNLICENSED");
  setLicense("apps/daemon/package.json", "UNLICENSED");
});
afterEach(() => rmSync(copy, { recursive: true, force: true }));

describe("licence rule (M13R57)", () => {
  it("accepts today: UNLICENSED or no field, with no LICENSE file", () => {
    expect(checkRelease(copy)).toEqual([]);
    setLicense("package.json", "UNLICENSED");
    setLicense("apps/daemon/package.json", "UNLICENSED");
    expect(checkRelease(copy)).toEqual([]);
  });

  it.each(["AGPL-3.0-only", "AGPL-3.0-or-later"])("accepts %s with every file in place", (id) => {
    licensed(id);
    expect(checkRelease(copy)).toEqual([]);
  });

  it("fails an UNLICENSED field next to a LICENSE file", () => {
    put("LICENSE", AFFERO);
    expect(problems()).toContain("LICENSE");
    setLicense("package.json", "UNLICENSED");
    expect(problems()).toContain("LICENSE");
  });

  it.each(["Apache-2.0", "MIT", "AGPL-3.0", "agpl-3.0-or-later"])(
    "fails the unknown project licence %s",
    (id) => {
      licensed(id);
      expect(problems()).toContain("license");
    },
  );

  it("fails an AGPL id with no LICENSE file, or a LICENSE that is not the GNU Affero text", () => {
    licensed("AGPL-3.0-or-later");
    rmSync(join(copy, "LICENSE"));
    expect(problems()).toContain("LICENSE");
    put("LICENSE", "                    GNU GENERAL PUBLIC LICENSE\n");
    expect(problems()).toContain("AFFERO");
  });

  it("fails when the daemon package says something else than the root", () => {
    licensed("AGPL-3.0-or-later");
    setLicense("apps/daemon/package.json", "AGPL-3.0-only");
    expect(problems()).toContain("apps/daemon/package.json");
    setLicense("apps/daemon/package.json", undefined);
    expect(problems()).toContain("apps/daemon/package.json");
  });

  it("fails without LICENSES/Apache-2.0.txt, or when the notices do not name it", () => {
    licensed("AGPL-3.0-or-later");
    rmSync(join(copy, "LICENSES/Apache-2.0.txt"));
    expect(problems()).toContain("LICENSES/Apache-2.0.txt");
    licensed("AGPL-3.0-or-later");
    put("THIRD_PARTY_NOTICES.md", "nothing here\n");
    expect(problems()).toContain("THIRD_PARTY_NOTICES.md");
  });
});

describe("trigger rule", () => {
  it("accepts the pre-flip and the post-flip shapes", () => {
    expect(checkRelease(copy)).toEqual([]);
    flipped();
    expect(checkRelease(copy)).toEqual([]);
  });

  it.each([
    ["push of another branch", "    branches: [release]"],
    ["push of tags", "    tags: ['v*']"],
    ["push of main and a path filter", "    branches: [main]\n    paths: [src/**]"],
    ["push with no filter", "    {}"],
  ])("rejects %s", (_name, body) => {
    flipped();
    edit(WORKFLOW, (t) => t.replace("  push:\n    branches: [main]", `  push:\n${body}`));
    expect(problems()).toContain("push");
  });

  it.each(["pull_request", "schedule", "workflow_run", "pull_request_target"])(
    "rejects %s next to a flip",
    (t) => {
      flipped();
      edit(WORKFLOW, (text) => text.replace("on:\n", `on:\n  ${t}:\n`));
      expect(problems()).toContain(t);
    },
  );

  it("rejects a push without workflow_dispatch", () => {
    flipped();
    edit(WORKFLOW, (t) =>
      t.replace(
        /on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:[\s\S]*?permissions:/,
        "on:\n  push:\n    branches: [main]\npermissions:",
      ),
    );
    expect(problems()).toContain("trigger");
  });
});

describe("if: rule", () => {
  it("rejects an on: flipped while stable keeps the dispatch-only if:", () => {
    flipped();
    edit(WORKFLOW, (t) =>
      t.replace("(github.event_name == 'push' || inputs.channel == 'stable')", "inputs.channel == 'stable'"),
    );
    expect(problems()).toContain("job stable if");
  });

  it("rejects the flipped if: while on: is not flipped", () => {
    flipped();
    edit(WORKFLOW, (t) => t.replace("  push:\n    branches: [main]\n", ""));
    expect(problems()).toContain("job stable if");
  });

  it("rejects next when it also runs on a push, and any variation of the stable shape", () => {
    flipped();
    edit(WORKFLOW, (t) =>
      t.replace(
        "&& inputs.channel == 'next'",
        "&& (github.event_name == 'push' || inputs.channel == 'next')",
      ),
    );
    expect(problems()).toContain("job next if");
    flipped();
    cpSync(join(REPO, WORKFLOW), join(copy, WORKFLOW));
    flipped();
    edit(WORKFLOW, (t) => t.replace("github.event_name == 'push' ||", "github.event_name != 'x' ||"));
    expect(problems()).toContain("job stable if");
  });
});

describe("cache rule (M13R36)", () => {
  it('passes on the real workflow: both write-token jobs say cache: "false"', () => {
    const text = readFileSync(join(REPO, WORKFLOW), "utf8");
    expect(text.match(/cache: "false"/g)).toHaveLength(2);
  });

  it.each(["stable", "next"])('fails when job %s drops cache: "false"', (job) => {
    edit(WORKFLOW, (t) => {
      const start = t.indexOf(`  ${job}:`);
      const head = t.slice(0, start);
      const rest = t.slice(start).replace(/\n {8}with:\n {10}cache: "false"/, "");
      return head + rest;
    });
    expect(problems()).toContain(`job ${job}`);
    expect(problems()).toContain('cache: "false"');
  });

  it("fails on cache: true and on a cache input of another value", () => {
    edit(WORKFLOW, (t) => t.replaceAll('cache: "false"', 'cache: "true"'));
    expect(problems()).toContain('cache: "false"');
  });
});

describe("pi-compat schedule (flip)", () => {
  it("accepts dispatch only before the flip and dispatch plus the nightly schedule after it", () => {
    expect(read(PI_COMPAT)).not.toContain("schedule:");
    expect(checkRelease(copy)).toEqual([]);
    flipped();
    expect(read(PI_COMPAT)).toContain('cron: "17 3 * * *"');
    expect(checkRelease(copy)).toEqual([]);
  });

  it("rejects the schedule while release.yml is not flipped, and the missing schedule once it is", () => {
    edit(PI_COMPAT, (t) => t.replace("on:\n", 'on:\n  schedule:\n    - cron: "17 3 * * *"\n'));
    expect(problems()).toContain("pi-compat.yml");
    flippedRelease();
    expect(problems()).toBe("");
    flipped();
    edit(PI_COMPAT, (t) => t.replace(/ {2}schedule:\n.*\n.*\n/, ""));
    expect(problems()).toContain("pi-compat.yml");
  });

  it.each([
    ["another cron", 'on:\n  schedule:\n    - cron: "0 * * * *"\n'],
    ["two schedules", 'on:\n  schedule:\n    - cron: "17 3 * * *"\n    - cron: "17 4 * * *"\n'],
    ["a push trigger", 'on:\n  push:\n    branches: [main]\n  schedule:\n    - cron: "17 3 * * *"\n'],
  ])("rejects %s after the flip", (_name, head) => {
    flipped();
    edit(PI_COMPAT, (t) => t.replace(/on:\n {2}schedule:\n {4}- cron: "17 3 \* \* \*"\n/, head));
    expect(problems()).toContain("pi-compat.yml");
  });

  it("rejects a trigger other than dispatch before the flip", () => {
    edit(PI_COMPAT, (t) => t.replace("on:\n", "on:\n  pull_request:\n"));
    expect(problems()).toContain("pi-compat.yml");
  });
});

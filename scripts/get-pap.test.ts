import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts/get-pap.sh");
const FIXTURE = readFileSync(join(REPO_ROOT, "scripts/fixtures/feed-stable.env"), "utf8");
const GITHUB = "https://github.com/SoulKyu/pi-agentic-platform/releases";
const STABLE_FEED_URL = `${GITHUB}/latest/download/pap-feed-stable.env`;
const NEXT_FEED_URL = `${GITHUB}/download/next/pap-feed-next.env`;
const field = (name: string): string => {
  const line = FIXTURE.split("\n").find((l) => l.startsWith(`${name}=`));
  if (line === undefined) throw new Error(`fixture has no ${name}`);
  return line.slice(name.length + 1);
};
const INSTALLER_URL = field("INSTALLER_URL");
const ARCHIVE_URL = field("ARCHIVE_URL");

const FAKE_CURL = `#!/bin/sh
url=""
for a in "$@"; do
  [ "\${prev:-}" = "--output" ] && out="$a"
  prev="$a"
  url="$a"
done
printf '%s\\n' "$*" >> "$FAKE_CURL_LOG"
while IFS='	' read -r u f; do
  if [ "$u" = "$url" ]; then cp "$f" "$out"; exit 0; fi
done < "$FAKE_CURL_TABLE"
echo "fake curl: no such url" >&2
exit 22
`;

const installerBody = (code: number): string =>
  `#!/bin/bash\nprintf '%s\\n' "$@" > "$OUT/argv"\ncat > "$OUT/stdin"\nexit ${code}\n`;
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

let dir: string;
let tmp: string;
let out: string;

interface Options {
  args?: string[];
  installerExit?: number;
  hash?: string;
  feedEdit?: (feed: string) => string;
  feedUrl?: string;
  extraTable?: [string, string][];
  env?: Record<string, string>;
  script?: string;
  input?: string;
  emptyTable?: boolean;
}

const run = (options: Options = {}) => {
  rmSync(join(dir, "curl.log"), { force: true });
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out);
  const installer = installerBody(options.installerExit ?? 0);
  writeFileSync(join(dir, "installer.sh"), installer);
  writeFileSync(join(dir, "archive.tgz"), "archive bytes");
  const feed = (options.feedEdit ?? ((f) => f))(
    FIXTURE.replace(/^INSTALLER_SHA256=.*$/m, `INSTALLER_SHA256=${options.hash ?? sha(installer)}`),
  );
  writeFileSync(join(dir, "feed.env"), feed);
  const table: [string, string][] = options.emptyTable
    ? []
    : [
        [STABLE_FEED_URL, join(dir, "feed.env")],
        [NEXT_FEED_URL, join(dir, "feed.env")],
        [INSTALLER_URL, join(dir, "installer.sh")],
        [ARCHIVE_URL, join(dir, "archive.tgz")],
        ...(options.extraTable ?? []),
      ];
  writeFileSync(join(dir, "table.tsv"), table.map(([u, f]) => `${u}\t${f}`).join("\n") + "\n");
  const result = spawnSync("sh", [options.script ?? SCRIPT, ...(options.args ?? [])], {
    encoding: "utf8",
    input: options.input ?? "",
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      HOME: dir,
      TMPDIR: tmp,
      OUT: out,
      FAKE_CURL_LOG: join(dir, "curl.log"),
      FAKE_CURL_TABLE: join(dir, "table.tsv"),
      ...options.env,
    },
  });
  const calls = existsSync(join(dir, "curl.log"))
    ? readFileSync(join(dir, "curl.log"), "utf8").split("\n").filter(Boolean)
    : [];
  return { ...result, calls, urls: calls.map((c) => c.split(" ").at(-1)) };
};
const installerRan = (): boolean => existsSync(join(out, "argv"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-get-pap-"));
  tmp = join(dir, "tmp");
  out = join(dir, "out");
  mkdirSync(join(dir, "bin"));
  mkdirSync(tmp);
  mkdirSync(out);
  writeFileSync(join(dir, "bin/curl"), FAKE_CURL, { mode: 0o755 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const supported = process.platform === "linux" && process.arch === "x64";
const describeHost = supported ? describe : describe.skip;

describe("get-pap.sh text", () => {
  const text = readFileSync(SCRIPT, "utf8");

  it("parses as POSIX sh", () => {
    expect(spawnSync("sh", ["-n", SCRIPT]).status).toBe(0);
  });

  it("uses none of the dangerous constructs", () => {
    expect(text).not.toMatch(/\beval\b/);
    expect(text).not.toMatch(/\bsource\b/);
    expect(text).not.toMatch(/^\s*\. /m);
    expect(text).not.toMatch(/\bsudo\b|\bwget\b/);
    expect(text).not.toMatch(/\|\s*sh\b/);
  });

  it("keeps set -eu and one curl call with the https, size and time limits", () => {
    expect(text).toMatch(/^set -eu$/m);
    const curls = text.split("\n").filter((l) => /\bcurl\b/.test(l) && !l.trimStart().startsWith("#"));
    const call = text.slice(text.indexOf("curl --fail"), text.indexOf("|| die", text.indexOf("curl --fail")));
    expect(call).toContain("--proto '=https'");
    expect(call).toContain("--proto-redir '=https'");
    expect(call).toContain("--max-filesize");
    expect(call).toContain("--max-time");
    expect(curls.filter((l) => l.includes("curl --fail"))).toHaveLength(1);
  });
});

describeHost("get-pap.sh run against a fake curl", () => {
  it("fetches the feed, the installer and the archive, then runs the installer with the forwarded flags", () => {
    const result = run({ args: ["stable", "--", "--port", "7791"] });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.urls).toEqual([STABLE_FEED_URL, INSTALLER_URL, ARCHIVE_URL]);
    expect(readFileSync(join(out, "argv"), "utf8")).toBe("--port\n7791\n");
    expect(result.stdout).toBe(`get-pap: pap 0.1.0 (${field("RELEASE_ID")}), channel stable\n`);
    for (const call of result.calls) {
      expect(call).toContain("--proto =https");
      expect(call).toContain("--proto-redir =https");
      expect(call).toContain("--max-filesize");
      expect(call).toContain("--max-time");
    }
  });

  it("defaults to stable without arguments, and takes flags after a bare --", () => {
    const result = run({ args: ["--", "--port", "7792"] });
    expect(result.status).toBe(0);
    expect(result.urls[0]).toBe(STABLE_FEED_URL);
    expect(readFileSync(join(out, "argv"), "utf8")).toBe("--port\n7792\n");
  });

  it("asks for the next channel's feed URL", () => {
    const result = run({ args: ["next"] });
    expect(result.urls[0]).toBe(NEXT_FEED_URL);
    expect(result.status).toBe(0);
  });

  it("refuses an unknown channel before any download", () => {
    const result = run({ args: ["beta"] });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("get-pap: the channel is stable or next\n");
    expect(result.calls).toEqual([]);
    expect(installerRan()).toBe(false);
  });

  it("refuses an installer whose SHA-256 differs from the feed and never runs it", () => {
    const result = run({ hash: "0".repeat(64) });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "get-pap: the installer does not match the feed's checksum: nothing was run\n",
    );
    expect(installerRan()).toBe(false);
    expect(result.urls).toEqual([STABLE_FEED_URL, INSTALLER_URL]);
  });

  it("refuses an archive URL on a foreign host or for another repository", () => {
    for (const bad of [
      "https://evil.example/SoulKyu/pi-agentic-platform/releases/download/v0.1.0/x",
      "https://github.com/other/x/releases/download/v0.1.0/x",
      "http://github.com/SoulKyu/pi-agentic-platform/releases/download/v0.1.0/x",
    ]) {
      const result = run({ feedEdit: (f) => f.replace(/^ARCHIVE_URL=.*$/m, `ARCHIVE_URL=${bad}`) });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("get-pap: bad feed: ARCHIVE_URL\n");
      expect(installerRan()).toBe(false);
    }
  });

  it("refuses an installer URL for a different repository", () => {
    const result = run({
      feedEdit: (f) =>
        f.replace(
          /^INSTALLER_URL=.*$/m,
          `INSTALLER_URL=https://github.com/other/x/releases/download/v0.1.0/${field("INSTALLER_NAME")}`,
        ),
    });
    expect(result.stderr).toBe("get-pap: bad feed: INSTALLER_URL\n");
    expect(installerRan()).toBe(false);
  });

  it("refuses a feed with an extra line and never executes it", () => {
    const marker = join(dir, "marker");
    for (const extra of ["EXTRA=1", `X=$(touch ${marker})`, `touch ${marker}`]) {
      const result = run({ feedEdit: (f) => `${f}${extra}\n` });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("get-pap: bad feed: unknown line\n");
      expect(installerRan()).toBe(false);
      expect(existsSync(marker)).toBe(false);
    }
  });

  it("refuses a feed with a missing line", () => {
    const result = run({ feedEdit: (f) => f.replace(/^ARCHIVE_NAME=.*\n/m, "") });
    expect(result.stderr).toBe("get-pap: bad feed: a line is missing\n");
    expect(installerRan()).toBe(false);
  });

  it("refuses names that do not match the release id, and names or URLs with ..", () => {
    const cases: [RegExp, string, string][] = [
      [/^INSTALLER_NAME=.*$/m, "INSTALLER_NAME=pap-install-../x.sh", "INSTALLER_NAME"],
      [
        /^INSTALLER_NAME=.*$/m,
        "INSTALLER_NAME=pap-install-other.sh",
        "the file names do not match the release id",
      ],
      [/^ARCHIVE_NAME=.*$/m, "ARCHIVE_NAME=pap-../x-linux-x64.tar.gz", "ARCHIVE_NAME"],
      [/^VERSION=.*$/m, "VERSION=1.0 && true", "VERSION"],
      [/^INSTALLER_SHA256=.*$/m, "INSTALLER_SHA256=ABC", "INSTALLER_SHA256"],
      [
        /^INSTALLER_URL=.*$/m,
        `INSTALLER_URL=https://github.com/SoulKyu/pi-agentic-platform/releases/download/../../x/${field("INSTALLER_NAME")}`,
        "INSTALLER_URL",
      ],
    ];
    for (const [pattern, replacement, what] of cases) {
      const result = run({ feedEdit: (f) => f.replace(pattern, replacement) });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(new RegExp(`^get-pap: (bad feed: )?.*${what}`));
      expect(installerRan()).toBe(false);
    }
  });

  it("validates PAP_GET_REPO as owner/name and uses it for the URLs", () => {
    for (const repo of ["a/b c", "a/b/c", "a/../b", "plain", "/a/b", "a/b/", "a//b", ""]) {
      const result = run({ env: { PAP_GET_REPO: repo } });
      if (repo === "") continue; // unset-equivalent: falls back to the default repository
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("get-pap: PAP_GET_REPO is not owner/name\n");
      expect(result.calls).toEqual([]);
    }
    const base = "https://github.com/fork/mirror/releases";
    const result = run({
      env: { PAP_GET_REPO: "fork/mirror" },
      extraTable: [
        [`${base}/latest/download/pap-feed-stable.env`, join(dir, "feed.env")],
        [`${base}/download/v0.1.0/${field("INSTALLER_NAME")}`, join(dir, "installer.sh")],
        [`${base}/download/v0.1.0/${field("ARCHIVE_NAME")}`, join(dir, "archive.tgz")],
      ],
      feedEdit: (f) => f.replaceAll("SoulKyu/pi-agentic-platform", "fork/mirror"),
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.urls[0]).toBe(`${base}/latest/download/pap-feed-stable.env`);
  });

  it("says which URL failed when a download fails", () => {
    const result = run({ emptyTable: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`get-pap: download failed: ${STABLE_FEED_URL}`);
    expect(installerRan()).toBe(false);
  });

  it("starts the installer with standard input from /dev/null", () => {
    run({ input: "must-not-reach-the-installer\n" });
    expect(readFileSync(join(out, "stdin"), "utf8")).toBe("");
  });

  it.each([0, 1, 3, 4, 5])("exits with the installer's exit code %i", (code) => {
    const result = run({ installerExit: code });
    expect(result.status).toBe(code);
    expect(installerRan()).toBe(true);
  });

  it("removes its work folder on success, on installer failure and on every refusal", () => {
    const runs: Options[] = [
      {},
      { installerExit: 4 },
      { hash: "f".repeat(64) },
      { feedEdit: (f) => `${f}EXTRA=1\n` },
      { feedEdit: (f) => f.replace(/^ARCHIVE_URL=.*$/m, "ARCHIVE_URL=https://evil.example/x") },
    ];
    for (const options of runs) {
      run(options);
      expect(readdirSync(tmp)).toEqual([]);
    }
  });

  it.skipIf(process.getuid?.() !== 0)("refuses to run as root", () => {
    const result = run();
    expect(result.stderr).toBe("get-pap: do not run as root: pap is a user service\n");
    expect(result.status).toBe(1);
  });

  it("runs nothing when the script is cut after any of its lines", () => {
    const lines = readFileSync(SCRIPT, "utf8").split("\n");
    expect(lines.length).toBeGreaterThan(40);
    const cutDir = mkdtempSync(join(tmpdir(), "pap-get-pap-cut-"));
    try {
      for (let keep = 1; keep < lines.length; keep += 1) {
        const text = lines.slice(0, keep).join("\n");
        if (/^main "\$@"/m.test(text)) continue;
        const cut = join(cutDir, `cut-${keep}.sh`);
        writeFileSync(cut, `${text}\n`);
        const result = run({ script: cut });
        expect(result.calls, `cut after line ${keep}`).toEqual([]);
        expect(installerRan(), `cut after line ${keep}`).toBe(false);
      }
    } finally {
      rmSync(cutDir, { recursive: true, force: true });
    }
  });
});

// S7 cross-check: does the real `pi` CLI honour a trust.json written by the SDK's ProjectTrustStore?
// The probe project holds a .pi/extension whose factory appends to a marker file, so "loaded" is observable.
// No provider key exists in the temp agent dir and the run is offline: the CLI stops at "no model", no LLM call is made.
// Run: cd spikes/s7 && PI_OFFLINE=1 PI_TELEMETRY=0 node cli-check.ts > cli-results.json
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pap-s7-cli-")));
const scrub = (text: string): string => text.split(root).join("<tmp>");
const pi = join(import.meta.dirname, "node_modules", ".bin", "pi");

interface Case {
  name: string;
  trust?: boolean;
  settings?: Record<string, unknown>;
  args?: string[];
}

const run = (testCase: Case, index: number) => {
  const home = join(root, `home-${index}`);
  const agentDir = join(root, `agent-${index}`);
  const project = join(root, `project-${index}`);
  const marker = join(root, `marker-${index}`);
  mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(project, ".pi", "extensions", "marker.js"), 'import { appendFileSync } from "node:fs";\nexport default function () { appendFileSync(process.env.S7_MARKER, "factory ran\\n"); }\n');
  if (testCase.settings) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(testCase.settings));
  if (testCase.trust !== undefined) new ProjectTrustStore(agentDir).set(project, testCase.trust);
  const trustPath = join(agentDir, "trust.json");
  const trustBefore = statSync(trustPath, { throwIfNoEntry: false }) ? readFileSync(trustPath, "utf8") : null;
  const result = spawnSync(pi, ["--print", "hello", "--no-session", ...(testCase.args ?? [])], {
    cwd: project,
    timeout: 60_000,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: home, LANG: process.env.LANG, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", S7_MARKER: marker },
  });
  const trustAfter = statSync(trustPath, { throwIfNoEntry: false }) ? readFileSync(trustPath, "utf8") : null;
  return {
    case: testCase.name,
    extensionFactoryRan: statSync(marker, { throwIfNoEntry: false }) !== undefined,
    trustFileUnchangedByCli: trustBefore === trustAfter,
    trustFileAfter: trustAfter === null ? null : scrub(trustAfter),
    exitCode: result.status,
    stderrFirstLine: scrub((result.stderr?.toString() ?? "").split("\n").find((line) => line.trim() !== "") ?? ""),
  };
};

const cases: Case[] = [
  { name: "no trust.json, defaultProjectTrust unset" },
  { name: "trust.json written by ProjectTrustStore: project true", trust: true },
  { name: "trust.json written by ProjectTrustStore: project false", trust: false },
  { name: "no trust.json, --approve", args: ["--approve"] },
  { name: "trust.json project true, --no-approve", trust: true, args: ["--no-approve"] },
  { name: "no trust.json, settings defaultProjectTrust always", settings: { defaultProjectTrust: "always" } },
];
const results = cases.map(run);
console.log(JSON.stringify(results, null, 2));
rmSync(root, { recursive: true, force: true });

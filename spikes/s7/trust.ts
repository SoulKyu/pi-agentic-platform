// S7 probe: who owns <agentDir>/trust.json, what it holds, how a host must gate project resources on it.
// Run: cd spikes/s7 && PI_OFFLINE=1 PI_TELEMETRY=0 node trust.ts > results.json
// Everything happens in one temp dir (HOME, PI_CODING_AGENT_DIR and every agentDir live there); the real ~/.pi/agent is never touched.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pap-s7-")));
const home = join(root, "home");
mkdirSync(home);
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = join(root, "unused-agent-dir");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
const { createAgentSessionServices, hasTrustRequiringProjectResources, ProjectTrustStore, SettingsManager } = await import("@earendil-works/pi-coding-agent");

const scrub = (text: string): string => text.split(root).join("<tmp>");
const dir = (...parts: string[]): string => {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
};
const touch = (path: string, text = "{}\n"): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const filesIn = (path: string): string[] => (readdirSync(path, { recursive: true }) as string[]).sort();
const regularFilesIn = (path: string): string[] => filesIn(path).filter((entry) => statSync(join(path, entry)).isFile());
const readText = (path: string): string => scrub(readFileSync(path, "utf8"));
const attempt = <T>(task: () => T): { value?: T; error?: string; ms: number } => {
  const start = performance.now();
  try {
    return { value: task(), ms: Math.round(performance.now() - start) };
  } catch (error) {
    return { error: scrub(error instanceof Error ? error.message : String(error)), ms: Math.round(performance.now() - start) };
  }
};

// 1. The brief's probe: what ProjectTrustStore.set() writes.
const agentDir = dir("agent-main");
const project = dir("project-main");
const requiresTrustEmpty = hasTrustRequiringProjectResources(project);
mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
const requiresTrustWithExtensions = hasTrustRequiringProjectResources(project);
const store = new ProjectTrustStore(agentDir);
const decisionBeforeSet = store.get(project);
store.set(project, true);
const files = regularFilesIn(agentDir);
const written = {
  requiresTrustEmpty,
  requiresTrustWithExtensions,
  decisionBeforeSet,
  decision: store.get(project),
  files,
  entriesInAgentDirAfterGet: filesIn(agentDir),
  fileMode: (statSync(join(agentDir, "trust.json")).mode & 0o777).toString(8),
  contents: Object.fromEntries(files.map((file) => [file, readText(join(agentDir, file))])),
};

// 2. What makes a folder require trust (one fresh folder per layout; HOME is the temp home).
const layouts: Record<string, (folder: string) => void> = {
  "empty folder": () => undefined,
  "AGENTS.md only": (folder) => touch(join(folder, "AGENTS.md"), "# rules\n"),
  "bare .pi": (folder) => mkdirSync(join(folder, ".pi")),
  ".pi/settings.json": (folder) => touch(join(folder, ".pi", "settings.json")),
  ".pi/mcp.json": (folder) => touch(join(folder, ".pi", "mcp.json")),
  ".pi/extensions": (folder) => mkdirSync(join(folder, ".pi", "extensions"), { recursive: true }),
  ".pi/skills": (folder) => mkdirSync(join(folder, ".pi", "skills"), { recursive: true }),
  ".pi/prompts": (folder) => mkdirSync(join(folder, ".pi", "prompts"), { recursive: true }),
  ".pi/themes": (folder) => mkdirSync(join(folder, ".pi", "themes"), { recursive: true }),
  ".pi/SYSTEM.md": (folder) => touch(join(folder, ".pi", "SYSTEM.md"), "x\n"),
  ".pi/APPEND_SYSTEM.md": (folder) => touch(join(folder, ".pi", "APPEND_SYSTEM.md"), "x\n"),
  ".agents/skills in the folder": (folder) => mkdirSync(join(folder, ".agents", "skills"), { recursive: true }),
  ".agents/skills in a parent folder": (folder) => mkdirSync(join(dirname(folder), ".agents", "skills"), { recursive: true }),
};
const requiresTrust: Record<string, boolean> = {};
let layoutIndex = 0;
for (const [name, build] of Object.entries(layouts)) {
  const folder = dir(`layout-${layoutIndex++}`, "project");
  build(folder);
  requiresTrust[name] = hasTrustRequiringProjectResources(folder);
}
mkdirSync(join(home, ".agents", "skills"), { recursive: true });
requiresTrust["~/.agents/skills with the home folder as cwd"] = hasTrustRequiringProjectResources(home);

// 3. Decision lookup: nearest entry wins, the closest ancestor is inherited, null deletes.
const treeAgentDir = dir("agent-tree");
const tree = new ProjectTrustStore(treeAgentDir);
const parent = dir("tree");
const child = dir("tree", "a", "b");
const lookups: Array<Record<string, unknown>> = [];
const look = (step: string): void => {
  const entry = tree.getEntry(child);
  lookups.push({
    step,
    parent: tree.get(parent),
    child: tree.get(child),
    childEntryPath: entry ? scrub(entry.path) : null,
    file: regularFilesIn(treeAgentDir).includes("trust.json") ? readText(join(treeAgentDir, "trust.json")) : null,
  });
};
look("no decision");
tree.set(parent, true);
look("parent trusted");
tree.set(child, false);
look("child distrusted");
tree.set(child, null);
look("child decision removed");
tree.set(parent, null);
look("parent decision removed");
const linkTarget = dir("link-target");
symlinkSync(linkTarget, join(root, "link"));
tree.set(join(root, "link"), true);
const symlinkKeyIsRealPath = scrub(tree.getEntry(linkTarget)?.path ?? "") === "<tmp>/link-target";

// 4. Failure modes a host has to survive.
const failures: Record<string, unknown> = {};
const brokenStore = (name: string, text: string): ProjectTrustStore => {
  const brokenDir = dir(`agent-${name}`);
  writeFileSync(join(brokenDir, "trust.json"), text);
  return new ProjectTrustStore(brokenDir);
};
failures.unparsableJson = attempt(() => brokenStore("bad-json", "{not json").get(project));
failures.arrayInsteadOfObject = attempt(() => brokenStore("array", "[]").get(project));
failures.stringValue = attempt(() => brokenStore("string", JSON.stringify({ [project]: "yes" })).get(project));
const lockedDir = dir("agent-locked");
mkdirSync(join(lockedDir, "trust.json.lock"));
failures.lockHeldByAnotherProcess = attempt(() => new ProjectTrustStore(lockedDir).get(project));
const missingDir = join(root, "agent-missing");
failures.agentDirMissing = { ...attempt(() => new ProjectTrustStore(missingDir).get(project)), agentDirCreatedByGet: statSync(missingDir, { throwIfNoEntry: false }) !== undefined };
const readOnlyDir = dir("agent-readonly");
writeFileSync(join(readOnlyDir, "trust.json"), JSON.stringify({ [project]: true }));
chmodSync(readOnlyDir, 0o555);
failures.agentDirReadOnly = attempt(() => new ProjectTrustStore(readOnlyDir).get(project));
chmodSync(readOnlyDir, 0o755);
const readDir = dir("agent-read");
writeFileSync(join(readDir, "trust.json"), `${JSON.stringify({ [project]: true }, null, 2)}\n`);
const mtimeBefore = statSync(join(readDir, "trust.json")).mtimeMs;
new ProjectTrustStore(readDir).get(project);
failures.getLeavesFileUntouched = { mtimeUnchanged: statSync(join(readDir, "trust.json")).mtimeMs === mtimeBefore, entriesAfterGet: filesIn(readDir) };

// 5. Gating project extensions: the host passes resolveProjectTrust (what pi-web does); the SDK's default is trusted.
const gateAgentDir = dir("agent-gate");
const gateStore = new ProjectTrustStore(gateAgentDir);
const gate: Record<string, unknown> = {};
const openProject = async (name: string, options: { trustDecision?: boolean; settingsProjectTrusted?: boolean; resolve?: boolean }): Promise<void> => {
  const cwd = dir(`gate-${name}`);
  const marker = join(root, `gate-${name}.marker`);
  touch(join(cwd, ".pi", "extensions", "marker.js"), 'import { appendFileSync } from "node:fs";\nexport default function () { appendFileSync(process.env.S7_MARKER, "factory ran\\n"); }\n');
  if (options.trustDecision !== undefined) gateStore.set(cwd, options.trustDecision);
  process.env.S7_MARKER = marker;
  const settingsManager = SettingsManager.create(cwd, gateAgentDir, options.settingsProjectTrusted === undefined ? {} : { projectTrusted: options.settingsProjectTrusted });
  const services = await createAgentSessionServices({
    cwd,
    agentDir: gateAgentDir,
    settingsManager,
    ...(options.resolve ? { resourceLoaderReloadOptions: { resolveProjectTrust: async () => gateStore.get(cwd) === true } } : {}),
  });
  gate[name] = {
    ...options,
    isProjectTrusted: services.settingsManager.isProjectTrusted(),
    loadedExtensions: services.resourceLoader.getExtensions().extensions.map((extension) => scrub(extension.path)),
    factoryRuns: statSync(marker, { throwIfNoEntry: false }) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0,
  };
};
await openProject("no-gate-sdk-default", {});
await openProject("resolve-no-decision", { resolve: true });
await openProject("resolve-trusted", { resolve: true, trustDecision: true });
await openProject("resolve-distrusted", { resolve: true, trustDecision: false });
await openProject("settings-untrusted-no-resolver", { settingsProjectTrusted: false });

// 6. Resources that appear after the session opened (git pull, the model's write tool), then a reload without options:
// that is what AgentSession.reload() does (dist/core/agent-session.js:2948), so only the SettingsManager's sticky projectTrusted decides.
const lateStore = new ProjectTrustStore(dir("agent-late"));
const late: Record<string, unknown> = {};
const lateResources = async (name: string, hardened: boolean): Promise<void> => {
  const cwd = dir(`late-${name}`);
  const marker = join(root, `late-${name}.marker`);
  process.env.S7_MARKER = marker;
  const gated = !hardened && hasTrustRequiringProjectResources(cwd);
  const services = await createAgentSessionServices({
    cwd,
    agentDir: join(root, "agent-late"),
    settingsManager: SettingsManager.create(cwd, join(root, "agent-late"), hardened ? { projectTrusted: false } : {}),
    ...(hardened || gated ? { resourceLoaderReloadOptions: { resolveProjectTrust: async () => lateStore.get(cwd) === true } } : {}),
  });
  touch(join(cwd, ".pi", "extensions", "marker.js"), 'import { appendFileSync } from "node:fs";\nexport default function () { appendFileSync(process.env.S7_MARKER, "factory ran\\n"); }\n');
  await services.resourceLoader.reload();
  late[name] = {
    hardened,
    isProjectTrustedAfterReload: services.settingsManager.isProjectTrusted(),
    loadedExtensions: services.resourceLoader.getExtensions().extensions.map((extension) => scrub(extension.path)),
    factoryRuns: statSync(marker, { throwIfNoEntry: false }) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0,
  };
};
await lateResources("resolver-only-when-resources-exist", false);
await lateResources("projectTrusted-false-and-resolver-always", true);

console.log(JSON.stringify({ ...written, requiresTrust, lookups, symlinkKeyIsRealPath, failures, gate, late }, null, 2));
rmSync(root, { recursive: true, force: true });

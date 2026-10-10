import { blockedAttempts } from "./network-guard.ts";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { buildFaux, loadScript } from "./scripted.ts";

if (process.env.PI_OFFLINE !== "1" || process.env.PI_TELEMETRY !== "0") {
  throw new Error("run with PI_OFFLINE=1 PI_TELEMETRY=0");
}

type Route = "native" | "extension";
const RUNS = 20;
const VOLATILE = new Set(["timestamp", "id", "durationMs", "usage", "responseId"]);

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !VOLATILE.has(key))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

async function runOnce(fixture: string, route: Route) {
  const root = mkdtempSync(join(tmpdir(), "pap-s2-"));
  // Pi resolves ~/.pi/agent through these: point both at the per-run temp dir so nothing reaches the real one.
  const savedEnv = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, HOME: process.env.HOME };
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.HOME = root;
  try {
    const faux = buildFaux(loadScript(fileURLToPath(new URL(`./fixtures/${fixture}.json`, import.meta.url))));
    const modelRuntime = await ModelRuntime.create({
      authPath: join(root, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    if (route === "native") modelRuntime.registerNativeProvider(faux.provider);
    const viaExtension: InlineExtension = {
      name: "s2-scripted-provider",
      factory: (pi) => {
        pi.registerProvider(faux.provider);
      },
    };
    const services = await createAgentSessionServices({
      cwd: root,
      agentDir: root,
      modelRuntime,
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
      } as never),
      resourceLoaderOptions: {
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: route === "extension" ? [viaExtension] : [],
      },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(root),
      model: faux.model,
    });
    const events: string[] = [];
    session.subscribe((event) => {
      const nested = (event as { assistantMessageEvent?: { type: string } }).assistantMessageEvent;
      events.push(nested ? `${event.type}:${nested.type}` : event.type);
    });
    const started = performance.now();
    await session.prompt("go");
    const elapsedMs = performance.now() - started;
    // The system prompt embeds the cwd, which is a fresh temp dir per run.
    const transcript = normalize(JSON.parse(JSON.stringify(session.messages).replaceAll(root, "<cwd>")));
    session.dispose();
    return { events, transcript, elapsedMs };
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const report: Record<string, unknown> = { node: process.version };
for (const fixture of ["text", "tool", "quota"]) {
  for (const route of ["native", "extension"] as const) {
    const runs = [];
    for (let index = 0; index < RUNS; index++) runs.push(await runOnce(fixture, route));
    const hashes = new Set(runs.map((run) => hash({ events: run.events, transcript: run.transcript })));
    report[`${fixture}/${route}`] = {
      deterministic: hashes.size === 1,
      distinctHashes: hashes.size,
      medianMs: Math.round(median(runs.map((run) => run.elapsedMs))),
      events: runs[0]?.events,
      transcript: runs[0]?.transcript,
    };
  }
}
report.networkAttempts = blockedAttempts.length;
console.log(JSON.stringify(report, null, 2));

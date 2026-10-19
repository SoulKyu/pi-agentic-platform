import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Every secret-looking text the fixture plants carries this word: the output must never contain it. */
export const MARKER = "PLANTEDMARKER";
export const VAULT_VALUE = "vault-value-0123456789";

export interface Scratch {
  readonly root: string;
  readonly agentDir: string;
  readonly out: string;
  readonly outside: string;
  put(rel: string, content: string): void;
  json(rel: string, value: unknown): void;
  cleanup(): void;
}

export function scratch(): Scratch {
  const root = mkdtempSync(join(tmpdir(), "pap-profile-"));
  const put = (rel: string, content: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  return {
    root,
    agentDir: join(root, "agent"),
    out: join(root, "build", "pi-agent"),
    outside: join(root, "outside"),
    put,
    json: (rel, value) => put(rel, JSON.stringify(value)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function mkfifo(path: string): void {
  execFileSync("mkfifo", [path]);
}

/** A scratch Pi agent folder with everything the allowlist must keep out, planted at the top and inside a package. */
export function plantAgentDir(s: Scratch, version = "1.2.3"): void {
  const a = (rel: string) => `agent/${rel}`;
  s.json(a("auth.json"), { anthropic: { type: "api_key", key: `${MARKER}-auth` } });
  s.put(a("sessions/s.jsonl"), `${MARKER}-session\n`);
  s.put(a("mem0/store.db"), `${MARKER}-mem0`);
  s.put(a("pi-web-session-index.json"), `${MARKER}-index`);
  s.put(a(".credentials.json"), `${MARKER}-credentials`);
  s.put(a(".env"), `TOKEN=${MARKER}-env`);
  s.put(a("foo.json"), `{"k":"${MARKER}-foo"}`);
  s.json(a("settings.json"), {
    theme: `${MARKER}-theme`,
    apiKey: `${MARKER}-settings-key`,
    compaction: { enabled: true },
    defaultThinkingLevel: "high",
    defaultProvider: "acme",
    defaultModel: "m1",
    enabledModels: ["acme/m1"],
    packages: [
      "npm:pi-claude-bridge@1.0.0",
      "npm:pi-web-access@2.0.0",
      "npm:pi-mcp-adapter@3.0.0",
      "npm:pi-mem0@0.1.0",
      `npm:demo-pkg@${version}`,
      `git:https://user:${MARKER}-git@github.com/acme/tool@v1`,
      "../localpkg",
    ],
    skills: ["skills/hello", `${s.outside}/skills`],
  });
  for (const [name, v] of [
    ["pi-claude-bridge", "1.0.0"],
    ["pi-web-access", "2.0.0"],
    ["pi-mcp-adapter", "3.0.0"],
    ["pi-mem0", "0.1.0"],
    ["demo-pkg", version],
  ] as const) {
    s.json(a(`npm/node_modules/${name}/package.json`), {
      name,
      version: v,
      dependencies: { "dep-one": "^1.0.0" },
    });
    s.put(a(`npm/node_modules/${name}/index.js`), `export const name = "${name}";\n`);
  }
  s.json(a("npm/node_modules/dep-one/package.json"), { name: "dep-one", version: "1.0.1" });
  const pkg = (rel: string) => a(`npm/node_modules/demo-pkg/${rel}`);
  s.put(pkg(".git/config"), `[remote "o"]\n url = https://user:${MARKER}-gitcfg@host/x.git\n`);
  s.put(pkg(".npmrc"), `//registry/:_authToken=${MARKER}-npm\n`);
  s.put(pkg("key.pem"), `${MARKER}-pem`);
  s.put(pkg("id_rsa"), `${MARKER}-idrsa`);
  s.put(pkg(".env.local"), `${MARKER}-envlocal`);
  s.put(pkg("lib/a.js"), "export const a = 1;\n");
  s.put(`outside/leak.txt`, `${MARKER}-outside`);
  symlinkSync(s.outside, join(s.agentDir, "npm/node_modules/demo-pkg/link-out"));
  symlinkSync("lib/a.js", join(s.agentDir, "npm/node_modules/demo-pkg/link-in"));
  s.put(a("git/github.com/acme/tool/package.json"), `{"name":"tool"}`);
  s.put(a("git/github.com/acme/tool/.git/config"), `${MARKER}-gitrepo`);
  s.put("localpkg/package.json", `{"name":"localpkg"}`);
  s.put("localpkg/x.js", "export {};\n");
  s.put(a("skills/hello/SKILL.md"), "# hello\n");
  s.json(a("models.json"), {
    providers: {
      acme: {
        baseUrl: "https://api.acme.test/v1",
        api: "openai-completions",
        apiKey: `${MARKER}-literal-api-key`,
        headers: { "x-api-key": `${MARKER}-header-literal` },
        models: [{ id: "m1", name: "M1", contextWindow: 1000, headers: { "x-m": `${MARKER}-model-header` } }],
      },
    },
  });
  s.json(a("mcp.json"), {
    mcpServers: {
      inside: {
        command: join(s.agentDir, "npm/node_modules/demo-pkg/lib/a.js"),
        args: ["--x"],
        env: { API_TOKEN: `${MARKER}-mcp-env` },
      },
      outside: { command: "/usr/bin/true", args: [] },
      remote: { url: "https://mcp.test/sse" },
    },
  });
  s.json(a("web-search.json"), { exaApiKey: `${MARKER}-exa`, provider: "exa" });
}

export interface Listed {
  readonly rel: string;
  readonly text: string | null;
}

/** Every path under `root` with its text (null for a folder or a link), links not followed. */
export function listAll(root: string, rel = ""): Listed[] {
  const out: Listed[] = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const path = join(rel, entry.name);
    if (entry.isDirectory()) out.push({ rel: path, text: null }, ...listAll(root, path));
    else out.push({ rel: path, text: entry.isFile() ? readFileSync(join(root, path), "utf8") : null });
  }
  return out;
}

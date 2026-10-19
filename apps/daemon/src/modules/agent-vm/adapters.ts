import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { credentialName } from "@pap/contracts";
import { z } from "zod";
import { readJsonBounded } from "../../kernel/json-bounded.ts";
import { within } from "../../kernel/fs/boundary.ts";
import { MIN_SECRET_LENGTH } from "./secret-scan.ts";
import { IMAGE_AGENT_DIR, isLiteralValue, PLACEHOLDER_KEY } from "./profile-allowlist.ts";

const CONFIG_MAX_BYTES = 256 * 1024;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_SERVERS = 64;
const MAX_ARGS = 64;
const MAX_LEAVES = 4096;

/** `src`: the package's real path on the host; `dst`: its folder inside the profile (relative to the image's agent dir). */
export interface CopiedRoot {
  readonly src: string;
  readonly dst: string;
}
export interface AdapterInput {
  readonly agentDir: string;
  readonly out: string;
  readonly roots: readonly CopiedRoot[];
  readonly skipped: string[];
}

const Loose = z.record(z.string(), z.unknown());
const McpFile = z.object({ mcpServers: Loose });

function readConfig<T>(path: string, schema: z.ZodType<T>): T | null {
  const value = readJsonBounded(path, schema, CONFIG_MAX_BYTES);
  return value === "damaged" ? null : value;
}

function write(out: string, name: string, value: unknown): void {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
}

/** Only the names of the owner's key fields survive, each with a placeholder; nothing else of the original is carried. */
function webAccess({ agentDir, out }: AdapterInput): void {
  const original = readConfig(join(agentDir, "web-search.json"), Loose) ?? {};
  const config: Record<string, string> = {};
  for (const [name, value] of Object.entries(original))
    if (typeof value === "string" && /key/i.test(name) && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name))
      config[name] = PLACEHOLDER_KEY;
  write(out, "web-search.json", config);
}

function packagedBinary(input: AdapterInput, command: unknown): string | null {
  if (typeof command !== "string" || command.includes("\0") || !command.includes("/")) return null;
  let real: string;
  try {
    real = realpathSync(isAbsolute(command) ? command : resolve(input.agentDir, command));
  } catch {
    return null;
  }
  for (const root of input.roots)
    if (within(root.src, real))
      return `${IMAGE_AGENT_DIR}/${root.dst}/${relative(root.src, real)}`.replace(/\/$/, "");
  return null;
}

/** Stdio servers whose command is a binary inside a copied package stay (command and string args only); the rest is dropped. */
function mcpAdapter(input: AdapterInput): void {
  const original = readConfig(join(input.agentDir, "mcp.json"), McpFile);
  if (original === null) return;
  const servers: Record<string, { command: string; args: string[] }> = {};
  for (const [name, raw] of Object.entries(original.mcpServers).slice(0, MAX_SERVERS)) {
    const note = `mcp:${name.slice(0, 64)}`;
    const server = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    if (!SERVER_NAME.test(name)) input.skipped.push(`${note}: name`);
    else if (server.command === undefined) input.skipped.push(`${note}: not stdio`);
    else {
      const command = packagedBinary(input, server.command);
      if (command === null) input.skipped.push(`${note}: not a packaged binary`);
      else {
        const args = Array.isArray(server.args) ? server.args.filter((a) => typeof a === "string") : [];
        servers[name] = { command, args: args.slice(0, MAX_ARGS) };
      }
    }
  }
  write(input.out, "mcp.json", { mcpServers: servers });
}

const ADAPTERS: ReadonlyMap<string, (input: AdapterInput) => void> = new Map([
  ["pi-web-access", webAccess],
  ["pi-mcp-adapter", mcpAdapter],
]);

/**
 * pi-claude-bridge has no adapter on purpose (AVM-E25): its own config file never enters, and the worker exports
 * `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` itself (`pi-host/src/relay-key.ts`). A package pap does not know enters
 * without its config.
 */
export function applyAdapter(packageName: string, input: AdapterInput): void {
  ADAPTERS.get(packageName)?.(input);
}

function leaves(value: unknown, out: string[], field = "", depth = 0): void {
  if (out.length >= MAX_LEAVES || depth > 8) return;
  if (typeof value === "string") {
    if (credentialName(field) && value.length >= MIN_SECRET_LENGTH && isLiteralValue(value)) out.push(value);
  } else if (Array.isArray(value)) for (const item of value) leaves(item, out, field, depth + 1);
  else if (typeof value === "object" && value !== null)
    for (const [key, item] of Object.entries(value)) leaves(item, out, key, depth + 1);
}

/**
 * The literal secrets the owner's extension configs hold (web-search keys, MCP env and header values, MCP OAuth tokens):
 * only values under a credential-looking key (`credentialName`, the vocabulary of the MCP masker in `@pap/contracts`),
 * so `Content-Type: application/json` or `NODE_ENV=production` never refuse a build. They join the scan's needles whether or not their package is copied.
 */
export function adapterSecrets(agentDir: string): string[] {
  const found: string[] = [];
  for (const name of ["web-search.json", "mcp-auth.json"])
    leaves(readConfig(join(agentDir, name), Loose), found);
  const mcp = readConfig(join(agentDir, "mcp.json"), McpFile);
  for (const server of Object.values(mcp?.mcpServers ?? {}))
    if (typeof server === "object" && server !== null)
      for (const field of ["env", "headers"]) {
        const held = (server as Record<string, unknown>)[field];
        if (typeof held === "object" && held !== null)
          for (const [key, value] of Object.entries(held))
            if (typeof value === "string" && credentialName(key) && isLiteralValue(value)) found.push(value);
      }
  return found;
}

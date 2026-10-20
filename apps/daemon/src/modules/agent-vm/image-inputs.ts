import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { readJsonBounded } from "../../kernel/json-bounded.ts";
import { within } from "../../kernel/fs/boundary.ts";
import { type AdapterInput, adapterSecrets, applyAdapter, type CopiedRoot } from "./adapters.ts";
import {
  type CopyRun,
  copyPackage,
  literalValuesOf,
  type ModelsSource,
  modelsFile,
  parsePackageSource,
  sanitizeSettings,
  skip,
} from "./profile-allowlist.ts";
import type { WrittenEntry } from "./pick-map.ts";
import { type KnownSecrets, safeNotes, scanTree, walkTree } from "./secret-scan.ts";

const FORMAT = "pap-profile-1";
const JSON_MAX_BYTES = 1024 * 1024;
const MAX_PACKAGES = 64;
const MAX_NPM_PACKAGES = 2000;
const BASE_TAG = /^pap-agent-base-[0-9a-f]{64}$/;
const MEM0 = /pi-mem0/i;
const MEM0_NOTE = "pi-mem0: R17, memory stays out of VM images";
/** The bridge registers its own provider; it must keep its own route (`claude.internal`), not `llm.internal`. */
const OWN_ROUTE_PROVIDERS: ReadonlySet<string> = new Set(["claude-bridge"]);

const Loose = z.record(z.string(), z.unknown());
const Entry = z.union([z.string(), z.object({ source: z.string() }).loose()]);
const Entries = z.array(Entry).max(MAX_PACKAGES);
const ModelsFile = z.object({ providers: Loose.default({}) }).loose();
const PackageJson = z
  .object({
    version: z.string().optional(),
    dependencies: Loose.optional(),
    optionalDependencies: Loose.optional(),
    peerDependencies: Loose.optional(),
  })
  .loose();
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const GLOB = /[*?[{]/;
/** The only parts of the agent folder a copied root may live in (Pi's own install folders and the skills). */
const INSIDE_AGENT = ["npm", "git", "skills"];
const FILTER_KEYS = ["extensions", "skills", "prompts", "themes"] as const;

function statOrNull(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function realOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** A name for `local/<name>`, from the real folder's own name: never empty, `.` or `..`, never a hidden name. */
function localName(agentDir: string, path: string): string {
  const real = realOf(
    path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : resolve(agentDir, path),
  );
  const clean = basename(real ?? path)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "");
  return clean === "" ? "package" : clean;
}

class Build {
  readonly run: CopyRun;
  /** RT-18: a copied root may never be, or contain, one of these. */
  private readonly forbidden: string[];
  private readonly realAgent: string;
  private readonly realPapHome: string;
  readonly roots: CopiedRoot[] = [];
  readonly adapted = new Set<string>();
  /** AVM-E42: the entry written for each source kept (an unpinned npm version is known only after the install is read). */
  readonly written: WrittenEntry[] = [];
  readonly npm = new Set<string>();
  readonly localNames = new Set<string>();
  readonly agentDir: string;
  readonly out: string;
  constructor(agentDir: string, out: string, papHome: string) {
    this.agentDir = agentDir;
    this.out = out;
    this.realAgent = realpathSync(agentDir);
    this.realPapHome = realOf(papHome) ?? resolve(papHome);
    this.forbidden = [this.realAgent, realpathSync(out), this.realPapHome, realOf(homedir())].filter(
      (p) => p !== null,
    );
    const auth = statOrNull(join(agentDir, "auth.json"));
    this.run = {
      files: 0,
      bytes: 0,
      skipped: [],
      denyIds: auth === null ? [] : [{ dev: auth.dev, ino: auth.ino }],
    };
  }

  note = (text: string) => skip(this.run, text);

  copy(src: string, dst: string, label: string): boolean {
    let real: string;
    try {
      if (!statSync(src).isDirectory()) return false;
      real = realpathSync(src);
    } catch {
      return false;
    }
    const insideAgent = within(this.realAgent, real);
    const allowedInside = INSIDE_AGENT.some((name) => within(join(this.realAgent, name), real));
    if (
      this.forbidden.some((f) => within(real, f)) ||
      within(this.realPapHome, real) ||
      (insideAgent && !allowedInside)
    ) {
      this.note(
        `${label}: the folder holds or is part of the agent folder, the home, pap's home or the output`,
      );
      return false;
    }
    copyPackage(real, join(this.out, dst), this.run, label);
    this.roots.push({ src: real, dst });
    return true;
  }

  /** The dependencies a copied npm package needs sit beside it in `npm/node_modules`; they enter the same way. */
  npmWithDependencies(name: string): void {
    const queue = [name];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (this.npm.has(next)) continue;
      if (this.npm.size >= MAX_NPM_PACKAGES) throw new RangeError("profile folder too large: npm packages");
      const dst = `npm/node_modules/${next}`;
      if (!this.copy(join(this.agentDir, dst), dst, dst)) continue;
      this.npm.add(next);
      const json = readJsonBounded(join(this.agentDir, dst, "package.json"), PackageJson, JSON_MAX_BYTES);
      if (json === null || json === "damaged") continue;
      const groups: Array<[string, Record<string, unknown> | undefined]> = [
        ["dependency", json.dependencies],
        ["optional", json.optionalDependencies],
        ["peer", json.peerDependencies],
      ];
      for (const [kind, group] of groups)
        for (const dependency of Object.keys(group ?? {})) {
          if (MEM0.test(dependency)) this.note(MEM0_NOTE);
          else if (!NPM_NAME.test(dependency)) continue;
          else if (kind === "dependency" || existsSync(join(this.agentDir, "npm/node_modules", dependency)))
            queue.push(dependency);
          else if (kind === "optional") this.note(`npm:${dependency}: optional dependency not installed`);
        }
    }
  }

  /** One `packages` entry: the entry to write (or null) once the package is copied. */
  packageEntry(entry: z.infer<typeof Entry>): z.infer<typeof Entry> | null {
    const source = typeof entry === "string" ? entry : entry.source;
    const ref = parsePackageSource(source);
    let written: string | null = null;
    let name = "";
    if (ref.kind === "npm") {
      name = ref.name;
      written = MEM0.test(name) ? null : this.npmEntry(ref.name, ref.version);
    } else if (ref.kind === "git") {
      name = ref.path.split("/").at(-1) ?? ref.path;
      const dst = `git/${ref.host}/${ref.path}`;
      if (MEM0.test(name)) written = null;
      else if (this.copy(join(this.agentDir, dst), dst, dst))
        written = `git:${ref.host}/${ref.path}${ref.ref === null ? "" : `@${ref.ref}`}`;
      else this.note(`git:${ref.host}/${ref.path}: not installed`);
    } else if (ref.kind === "local") {
      name = localName(this.agentDir, ref.path);
      written = MEM0.test(name) ? null : this.localEntry(ref.path, name);
    } else this.note("settings.json: a package source was not understood");
    if (MEM0.test(name) || MEM0.test(source)) {
      this.note(MEM0_NOTE);
      return null;
    }
    if (written === null) return null;
    this.adapted.add(name);
    this.written.push({ source, written });
    if (typeof entry === "string") return written;
    const filters: Record<string, unknown> = {};
    for (const key of FILTER_KEYS) {
      const value = (entry as Record<string, unknown>)[key];
      if (Array.isArray(value)) filters[key] = value.filter((v) => typeof v === "string").slice(0, 64);
    }
    return { source: written, ...filters };
  }

  private npmEntry(name: string, pinned: string | null): string | null {
    const dir = join(this.agentDir, "npm/node_modules", name);
    const json = readJsonBounded(join(dir, "package.json"), PackageJson, JSON_MAX_BYTES);
    if (json === null || json === "damaged" || json.version === undefined) {
      this.note(`npm:${name}: not installed`);
      return null;
    }
    if (pinned !== null && /^\d/.test(pinned) && pinned !== json.version) {
      this.note(`npm:${name}: installed version differs from the pinned one`);
      return null;
    }
    this.npmWithDependencies(name);
    return `npm:${name}@${json.version}`;
  }

  private localEntry(path: string, name: string): string | null {
    const from =
      path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : resolve(this.agentDir, path);
    const real = realOf(from);
    if (real !== null && within(this.realAgent, real)) {
      this.note(`local/${name}: a local package inside the agent folder`);
      return null;
    }
    let unique = name;
    for (let n = 2; this.localNames.has(unique); n++) unique = `${name}-${n}`;
    if (!this.copy(from, `local/${unique}`, `local/${unique}`)) {
      if (!statOrNull(from)?.isDirectory()) this.note(`local/${name}: not a folder`);
      return null;
    }
    this.localNames.add(unique);
    return `local/${unique}`;
  }

  /** A `skills` entry kept only when it points inside a folder that was copied; rewritten to its place in the profile. */
  skillEntry(raw: unknown): string | null {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024 || raw.includes("\0")) {
      this.note("settings.json: a skills entry was not understood");
      return null;
    }
    // Exclusion and inclusion entries (`!`, `+`, `-`) keep their prefix.
    const prefix = /^[!+-]/.test(raw) ? (raw[0] ?? "") : "";
    const path = raw.slice(prefix.length);
    if (prefix !== "" && GLOB.test(path) && !isAbsolute(path) && !path.split("/").includes("..")) return raw;
    const real = realOf(isAbsolute(path) ? path : resolve(this.agentDir, path));
    const root = real === null ? undefined : this.roots.find((r) => within(r.src, real));
    if (real === null || root === undefined) {
      this.note("settings.json: a skills entry was dropped, it does not point inside the copied folders");
      return null;
    }
    return `${prefix}${join(root.dst, relative(root.src, real))}`;
  }
}

function readSettings(agentDir: string): Record<string, unknown> {
  const raw = readJsonBounded(join(agentDir, "settings.json"), Loose, JSON_MAX_BYTES);
  if (raw === "damaged") throw new Error("settings.json is unreadable");
  return raw ?? {};
}

function readModels(agentDir: string): ModelsSource {
  const raw = readJsonBounded(join(agentDir, "models.json"), ModelsFile, JSON_MAX_BYTES);
  if (raw === "damaged") throw new Error("models.json is unreadable");
  return raw ?? { providers: {} };
}

function derivedProviders(settings: Record<string, unknown>, authOnly: readonly string[]): string[] {
  const names: string[] = [...authOnly];
  if (typeof settings.defaultProvider === "string") names.push(settings.defaultProvider);
  if (Array.isArray(settings.enabledModels))
    for (const item of settings.enabledModels)
      if (typeof item === "string" && item.includes("/")) names.push(item.slice(0, item.indexOf("/")));
  return names.filter((name) => !OWN_ROUTE_PROVIDERS.has(name));
}

function writeJson(out: string, name: string, value: unknown): void {
  writeFileSync(join(out, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
}

/** The sha256 of a tree: names, kinds, the executable bit, link targets and file bytes; `format` keeps two uses apart. */
export function treeDigest(out: string, format = FORMAT): string {
  const hash = createHash("sha256").update(`${format}\n`);
  const chunk = Buffer.alloc(64 * 1024);
  for (const entry of walkTree(out)) {
    const exec = entry.mode & 0o111 ? "x" : "-";
    hash.update(`${entry.kind}\0${entry.rel}\0${exec}\0`);
    if (entry.kind === "link") hash.update(readlinkSync(join(out, entry.rel)));
    if (entry.kind === "file") {
      const fd = openSync(join(out, entry.rel), "r");
      try {
        for (
          let read = readSync(fd, chunk, 0, chunk.length, null);
          read > 0;
          read = readSync(fd, chunk, 0, chunk.length, null)
        )
          hash.update(chunk.subarray(0, read));
      } finally {
        closeSync(fd);
      }
    }
    hash.update("\n");
  }
  return hash.digest("hex");
}

/** `roots` are the real folders copied: what the next start fingerprints to know whether anything changed (I4). */
export type ProfileMade = { tag: string; skipped: string[]; written: WrittenEntry[]; roots: string[] };

function build(
  agentDir: string,
  out: string,
  secrets: KnownSecrets,
  papHome: string,
  baseTag: string,
  authOnly: readonly string[],
): ProfileMade {
  const b = new Build(agentDir, out, papHome);
  const settings = readSettings(agentDir);
  const models = readModels(agentDir);
  const entries = Entries.safeParse(settings.packages ?? []);
  if (!entries.success) b.note("settings.json: packages is not a list of sources");
  const packages = (entries.success ? entries.data : [])
    .map((e) => b.packageEntry(e))
    .filter((e) => e !== null);
  b.copy(join(agentDir, "skills"), "skills", "skills");
  const skills = [
    ...new Set((Array.isArray(settings.skills) ? settings.skills : []).map((s) => b.skillEntry(s))),
  ].filter((s) => s !== null);
  const profile: Record<string, unknown> = sanitizeSettings(settings);
  if (packages.length > 0) profile.packages = packages;
  if (skills.length > 0) profile.skills = skills;
  writeJson(out, "settings.json", profile);
  writeJson(out, "models.json", modelsFile(models, derivedProviders(settings, authOnly), b.run.skipped));
  const known = [...secrets, ...literalValuesOf(models), ...adapterSecrets(agentDir)];
  const input: AdapterInput = {
    agentDir: realpathSync(agentDir),
    out,
    roots: b.roots,
    skipped: b.run.skipped,
  };
  for (const name of b.adapted) applyAdapter(name, input);
  scanTree(out, known);
  return {
    tag: `pap-agent-profile-${treeDigest(out, `${FORMAT}\0${baseTag}`)}`,
    skipped: safeNotes(b.run.skipped, known),
    written: b.written,
    roots: b.roots.map((root) => root.src),
  };
}

/**
 * RT-18: writes the Pi profile the image gets, by allowlist (`out` is replaced). Every file written is scanned for every
 * known secret before the tag is computed; a hit or any other failure removes `out` and throws. `authProviders` (T15b) get a
 * relay entry like the settings' own. The base tag enters the profile tag: a new bundle, digest or weekly rebuild reaches it.
 */
export function prepareProfileContext(
  agentDir: string,
  out: string,
  secrets: KnownSecrets,
  papHome: string,
  baseTag: string,
  authProviders: readonly string[] = [],
): ProfileMade {
  if (!BASE_TAG.test(baseTag)) throw new Error("profile base tag is not a base tag");
  if (
    !isAbsolute(agentDir) ||
    !isAbsolute(out) ||
    !isAbsolute(papHome) ||
    within(agentDir, out) ||
    within(out, agentDir)
  )
    throw new Error("profile output folder is not usable");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  try {
    return build(agentDir, out, secrets, papHome, baseTag, authProviders);
  } catch (error) {
    rmSync(out, { recursive: true, force: true });
    throw error;
  }
}

/** The agent layer's tag; with no system package there is no layer and the agent runs on the profile image. */
export function agentLayerTag(profileTag: string, systemPackages: readonly string[]): string {
  if (systemPackages.length === 0) return profileTag;
  const names = [...new Set(systemPackages)].sort();
  const hex = createHash("sha256")
    .update(`pap-agent-layer-1\0${profileTag}\0${names.join("\n")}`)
    .digest("hex");
  return `pap-agent-agent-${hex}`;
}

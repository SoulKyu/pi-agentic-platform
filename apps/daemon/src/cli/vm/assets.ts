import { createHash } from "node:crypto";
import { closeSync, constants, createReadStream, fstatSync, openSync, readFileSync } from "node:fs";
import { z } from "zod";
import { CliError } from "../open-home.ts";
import bundled from "./vm-assets.json" with { type: "json" };

export const ASSET_NAMES = [
  "kata-static",
  "kata-tools-static",
  "nerdctl-full",
  "node",
  "pap-vmd",
  "pap-agent-bundle",
] as const;
export type AssetName = (typeof ASSET_NAMES)[number];

const SHA256 = /^[0-9a-f]{64}$/;
const PLACEHOLDER = "0".repeat(64);

const AssetSchema = z.object({
  name: z.enum(ASSET_NAMES),
  version: z.string().min(1).max(64),
  url: z.string().max(512).startsWith("https://"),
  sha256: z.string().regex(SHA256),
});
const FileSchema = z.object({
  assets: z.array(AssetSchema),
  baseImages: z.array(z.object({ name: z.string(), ref: z.string(), digest: z.string() })),
});
export type VmAsset = z.infer<typeof AssetSchema>;
export type VmAssets = Readonly<Record<AssetName, VmAsset>>;

/** Parses a `vm-assets.json`; every asset name must be present once. Fails closed on anything else. */
export function parseAssets(raw: unknown): VmAssets {
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) throw new CliError("vm-assets.json is not valid");
  const byName = new Map<string, VmAsset>();
  for (const asset of parsed.data.assets) {
    if (byName.has(asset.name)) throw new CliError(`vm-assets.json lists ${asset.name} twice`);
    byName.set(asset.name, asset);
  }
  for (const name of ASSET_NAMES) if (!byName.has(name)) throw new CliError(`vm-assets.json lacks ${name}`);
  return Object.fromEntries(byName) as VmAssets;
}

export const bundledAssets = (): VmAssets => parseAssets(bundled);

/** An entry nobody pinned yet (the file in the repository, before `release-assets` or T0a filled it). */
export const isPlaceholder = (asset: VmAsset): boolean => asset.sha256 === PLACEHOLDER;

export function sha256File(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", fail);
    stream.on("end", () => done(hash.digest("hex")));
  });
}

export type Download = (asset: VmAsset, dest: string) => Promise<void>;

/** Downloads one asset to `dest` and refuses it unless its SHA-256 is the pinned one. A placeholder is never accepted. */
export async function fetchVerified(asset: VmAsset, dest: string, download: Download): Promise<void> {
  if (isPlaceholder(asset))
    throw new CliError(
      `${asset.name} is not pinned in this build (placeholder SHA-256): pass --assets <the release's vm-assets.json>`,
    );
  await download(asset, dest);
  const actual = await sha256File(dest);
  if (actual !== asset.sha256) throw new CliError(`${asset.name}: SHA-256 mismatch, nothing was installed`);
}

/** The only entries a release fills per build (AVM-E35); everything else comes from the compiled file. */
export const RELEASE_FILLED: readonly AssetName[] = ["pap-vmd", "pap-agent-bundle"];

export interface OpenedFile {
  readonly isFile: boolean;
  readonly uid: number;
  readonly mode: number;
  readonly text: string;
}
export type OpenFile = (path: string) => OpenedFile;

/** Opens without following a final link and reads through the fstat'ed descriptor, so the checks hold for the bytes read. */
export const openNoFollow: OpenFile = (path) => {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new CliError(
      code === "ELOOP"
        ? `${path} is a symbolic link: refusing it`
        : `cannot open ${path} (${code ?? "error"})`,
    );
  }
  try {
    const stat = fstatSync(fd);
    return { isFile: stat.isFile(), uid: stat.uid, mode: stat.mode, text: readFileSync(fd, "utf8") };
  } finally {
    closeSync(fd);
  }
};

const sameEntry = (a: VmAsset, b: VmAsset): boolean =>
  a.version === b.version && a.url === b.url && a.sha256 === b.sha256;

/**
 * AVM-E35: `--assets` may replace pap-vmd and the agent bundle only. The file must be a regular file owned by root that
 * nobody else can write. Any other entry that differs from the compiled one is refused, naming it.
 */
export function applyOverrides(
  compiled: VmAssets,
  file: string,
  open: OpenFile,
): { assets: VmAssets; accepted: VmAsset[] } {
  const opened = open(file);
  if (!opened.isFile) throw new CliError(`${file} is not a regular file`);
  if (opened.uid !== 0) throw new CliError(`${file} is not owned by root (uid ${opened.uid}): refusing it`);
  if ((opened.mode & 0o022) !== 0)
    throw new CliError(`${file} is writable by its group or others: refusing it`);
  let raw: unknown;
  try {
    raw = JSON.parse(opened.text);
  } catch {
    throw new CliError(`${file} is not valid JSON`);
  }
  const given = parseAssets(raw);
  const merged: Record<string, VmAsset> = { ...compiled };
  const accepted: VmAsset[] = [];
  for (const name of ASSET_NAMES) {
    if (sameEntry(given[name], compiled[name])) continue;
    if (!RELEASE_FILLED.includes(name))
      throw new CliError(`${file} overrides ${name}: only ${RELEASE_FILLED.join(" and ")} may be overridden`);
    merged[name] = given[name];
    accepted.push(given[name]);
  }
  return { assets: merged as VmAssets, accepted };
}

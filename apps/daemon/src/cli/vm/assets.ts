import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
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

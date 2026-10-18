import { PROJECT_REPO } from "@pap/contracts";
import { z } from "zod";

export const CHANNELS = ["stable", "next"] as const;
export type Channel = (typeof CHANNELS)[number];

/** The only project the feed may name; every `github.com` URL must be under its releases (one constant, M6bR57). */
export const FEED_REPO = PROJECT_REPO;
export const FEED_PATH_PREFIX = `/${FEED_REPO}/releases/`;

/** The only hosts a release asset may come from or be redirected to (GitHub Releases and its asset CDN). */
export const FEED_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

/** A project release URL: https, `github.com`, no credentials or port, under the project's own releases path. */
export function isReleaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      parsed.pathname.startsWith(FEED_PATH_PREFIX) &&
      !/%(?:2e|2f|5c)/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

const ID = /^[A-Za-z0-9._-]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const asset = (name: RegExp) =>
  z.strictObject({
    name: z.string().regex(name),
    url: z.string().max(512).url(),
    size: z.number().int().positive().max(1_073_741_824),
  });

/** `pap-feed-<channel>.json`: what `pap update` trusts after it has fetched it over HTTPS from a host in FEED_HOSTS. */
export const FeedSchema = z
  .strictObject({
    format: z.literal(1),
    channel: z.enum(CHANNELS),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/)
      .max(64),
    releaseId: z
      .string()
      .regex(ID)
      .refine((id) => id !== "." && id !== "..", "release id is a path part"),
    publishedAt: z.string().datetime(),
    minNode: z.string().regex(/^\d+\.\d+$/),
    notes: z.string().max(512).url(),
    installer: asset(/^pap-install-[A-Za-z0-9._-]{1,64}\.sh$/).extend({ sha256: z.string().regex(HEX64) }),
    archive: asset(/^pap-[A-Za-z0-9._-]{1,64}-linux-x64\.tar\.gz$/),
  })
  .superRefine((feed, ctx) => {
    if (feed.installer.name !== `pap-install-${feed.releaseId}.sh`)
      ctx.addIssue({ code: "custom", message: "installer name does not match the release id" });
    if (feed.archive.name !== `pap-${feed.releaseId}-linux-x64.tar.gz`)
      ctx.addIssue({ code: "custom", message: "archive name does not match the release id" });
    for (const { name, url } of [feed.installer, feed.archive])
      if (!isReleaseUrl(url) || new URL(url).pathname.split("/").pop() !== name)
        ctx.addIssue({ code: "custom", message: "asset URL does not end with the asset name" });
    for (const url of [feed.installer.url, feed.archive.url, feed.notes]) {
      if (!isReleaseUrl(url))
        ctx.addIssue({ code: "custom", message: "asset URL is not an https release URL of this project" });
    }
  });
export type Feed = z.infer<typeof FeedSchema>;

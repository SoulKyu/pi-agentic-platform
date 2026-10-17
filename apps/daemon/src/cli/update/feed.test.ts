import { describe, expect, it } from "vitest";
import {
  type Channel,
  FEED_HOSTS,
  FEED_PATH_PREFIX,
  FEED_REPO,
  type Feed,
  FeedSchema,
  isReleaseUrl,
} from "./feed.ts";

const BASE = "https://github.com/SoulKyu/pi-agentic-platform/releases/download/v1.2.3";

function goodFeed(): Record<string, unknown> {
  return {
    format: 1,
    channel: "stable",
    version: "1.2.3",
    releaseId: "v1.2.3",
    publishedAt: "2026-10-17T07:08:00Z",
    minNode: "24.14",
    notes: `${BASE}/notes.md`,
    installer: {
      name: "pap-install-v1.2.3.sh",
      url: `${BASE}/pap-install-v1.2.3.sh`,
      size: 4096,
      sha256: "a".repeat(64),
    },
    archive: {
      name: "pap-v1.2.3-linux-x64.tar.gz",
      url: `${BASE}/pap-v1.2.3-linux-x64.tar.gz`,
      size: 52_428_800,
    },
  };
}

function withInstallerUrl(url: string): Record<string, unknown> {
  const feed = goodFeed();
  feed["installer"] = { ...(feed["installer"] as object), url };
  return feed;
}

describe("constants", () => {
  it("derives the path prefix from the repository and lists the three hosts", () => {
    expect(FEED_REPO).toBe("SoulKyu/pi-agentic-platform");
    expect(FEED_PATH_PREFIX).toBe("/SoulKyu/pi-agentic-platform/releases/");
    expect([...FEED_HOSTS].sort()).toEqual([
      "github.com",
      "objects.githubusercontent.com",
      "release-assets.githubusercontent.com",
    ]);
  });
});

describe("FeedSchema", () => {
  it("parses the good feed into a typed value", () => {
    const channel: Channel = "stable";
    const feed: Feed = FeedSchema.parse(goodFeed());
    expect(feed.channel).toBe(channel);
    expect(feed.installer.sha256).toBe("a".repeat(64));
    expect(feed.archive.size).toBe(52_428_800);
  });

  it("accepts a next pre-release version", () => {
    expect(FeedSchema.safeParse({ ...goodFeed(), channel: "next", version: "1.3.0-next.12" }).success).toBe(
      true,
    );
  });

  const bad: [string, (feed: Record<string, unknown>) => Record<string, unknown>][] = [
    ["an extra key", (feed) => ({ ...feed, extra: 1 })],
    [
      "an extra key inside an asset",
      (feed) => ({ ...feed, archive: { ...(feed["archive"] as object), extra: 1 } }),
    ],
    ["format 2", (feed) => ({ ...feed, format: 2 })],
    ["version 1.0", (feed) => ({ ...feed, version: "1.0" })],
    ["an unknown channel", (feed) => ({ ...feed, channel: "beta" })],
    ["a release id with a slash", (feed) => ({ ...feed, releaseId: "v1/2" })],
    [
      "an installer name not matching the release id",
      (feed) => ({ ...feed, installer: { ...(feed["installer"] as object), name: "pap-install-v9.9.9.sh" } }),
    ],
    [
      "an archive name not matching the release id",
      (feed) => ({
        ...feed,
        archive: { ...(feed["archive"] as object), name: "pap-v9.9.9-linux-x64.tar.gz" },
      }),
    ],
    [
      "a sha256 of 63 characters",
      (feed) => ({ ...feed, installer: { ...(feed["installer"] as object), sha256: "a".repeat(63) } }),
    ],
    [
      "an uppercase sha256",
      (feed) => ({ ...feed, installer: { ...(feed["installer"] as object), sha256: "A".repeat(64) } }),
    ],
    ["a size of 0", (feed) => ({ ...feed, archive: { ...(feed["archive"] as object), size: 0 } })],
    [
      "a size above 1 GiB",
      (feed) => ({ ...feed, archive: { ...(feed["archive"] as object), size: 1_073_741_825 } }),
    ],
    ["a pre-release with an empty identifier", (feed) => ({ ...feed, version: "1.3.0-next..1" })],
    ["a pre-release that is only a dot", (feed) => ({ ...feed, version: "1.3.0-." })],
    ["release id .", (feed) => ({ ...feed, releaseId: "." })],
    ["release id ..", (feed) => ({ ...feed, releaseId: ".." })],
    [
      "an installer URL whose last segment is not the installer name",
      (feed) => ({
        ...feed,
        installer: { ...(feed["installer"] as object), url: `${BASE}/pap-install-other.sh` },
      }),
    ],
    [
      "an archive URL whose last segment is not the archive name",
      (feed) => ({ ...feed, archive: { ...(feed["archive"] as object), url: `${BASE}/notes.md` } }),
    ],
    ["notes that is not a URL", (feed) => ({ ...feed, notes: "see the website" })],
    ["a notes URL on a foreign host", (feed) => ({ ...feed, notes: "https://evil.example/notes.md" })],
  ];
  for (const [label, mutate] of bad) {
    it(`refuses ${label}`, () => {
      expect(FeedSchema.safeParse(mutate(goodFeed())).success).toBe(false);
    });
  }

  const badUrls: [string, string][] = [
    [
      "a foreign host",
      "https://evil.example/SoulKyu/pi-agentic-platform/releases/download/v1.2.3/pap-install-v1.2.3.sh",
    ],
    ["http", "http://github.com/SoulKyu/pi-agentic-platform/releases/download/v1.2.3/pap-install-v1.2.3.sh"],
    [
      "a port",
      "https://github.com:8443/SoulKyu/pi-agentic-platform/releases/download/v1.2.3/pap-install-v1.2.3.sh",
    ],
    [
      "user info",
      "https://user:pw@github.com/SoulKyu/pi-agentic-platform/releases/download/v1.2.3/pap-install-v1.2.3.sh",
    ],
    [
      "the asset CDN (a redirect target, never a feed URL)",
      "https://objects.githubusercontent.com/SoulKyu/pi-agentic-platform/releases/download/v1.2.3/pap-install-v1.2.3.sh",
    ],
    [
      "another owner",
      "https://github.com/other-owner/pi-agentic-platform/releases/download/v1.2.3/pap-install-v1.2.3.sh",
    ],
    [
      "a sibling repository (the prefix ends with a slash)",
      "https://github.com/SoulKyu/pi-agentic-platform-evil/releases/download/v1.2.3/pap-install-v1.2.3.sh",
    ],
    ["an encoded slash", `${BASE}/..%2f..%2fother/pap-install-v1.2.3.sh`],
    ["an encoded dot", `${BASE}/a%2eb/pap-install-v1.2.3.sh`],
    ["an encoded backslash", `${BASE}/a%5Cb/pap-install-v1.2.3.sh`],
    [
      "a path traversal out of the releases folder",
      "https://github.com/SoulKyu/pi-agentic-platform/releases/../../other-owner/x/releases/a",
    ],
  ];
  for (const [label, url] of badUrls) {
    it(`refuses an installer URL on ${label}`, () => {
      expect(FeedSchema.safeParse(withInstallerUrl(url)).success).toBe(false);
    });
  }
});

describe("isReleaseUrl", () => {
  it("accepts the project's release URL and refuses garbage", () => {
    expect(isReleaseUrl(`${BASE}/a`)).toBe(true);
    expect(isReleaseUrl("not a url")).toBe(false);
    expect(isReleaseUrl("")).toBe(false);
  });
});

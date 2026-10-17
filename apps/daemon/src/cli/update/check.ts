import { CHANNELS, FeedSchema, FEED_PATH_PREFIX, type Channel, type Feed } from "./feed.ts";
import { fetchLimited, FetchRefused, type FetchLike } from "./fetch.ts";
import { compareVersions } from "./version.ts";

/** Where each channel's feed lives (M6bR21); both are under the project's own releases path. */
export const FEED_URLS: Readonly<Record<Channel, string>> = {
  stable: `https://github.com${FEED_PATH_PREFIX}latest/download/pap-feed-stable.json`,
  next: `https://github.com${FEED_PATH_PREFIX}download/next/pap-feed-next.json`,
};

const FEED_MAX_BYTES = 65_536;
const FEED_TIMEOUT_MS = 15_000;

/** A feed that cannot be used. `code` is a fetch code, `feed_invalid` (not JSON or not the schema) or `channel`; nothing remote. */
export class UpdateFeedError extends Error {
  override name = "UpdateFeedError";
  readonly code: FetchRefused["code"] | "feed_invalid" | "channel";
  constructor(code: UpdateFeedError["code"]) {
    super(`update feed refused (${code})`);
    this.code = code;
  }
}

/** The flag, else `PAP_UPDATE_CHANNEL`, else `stable`; null for a name that is not a channel. */
export function resolveChannel(flag: string | undefined, env: NodeJS.ProcessEnv): Channel | null {
  const wanted =
    flag ??
    (env.PAP_UPDATE_CHANNEL === undefined || env.PAP_UPDATE_CHANNEL === ""
      ? "stable"
      : env.PAP_UPDATE_CHANNEL);
  return (CHANNELS as readonly string[]).includes(wanted) ? (wanted as Channel) : null;
}

export interface UpdateAnswer {
  /** The feed's version against the running one: `newer` means an update exists. */
  readonly status: "newer" | "current" | "older";
  readonly feed: Feed;
}

/** One request for the channel's feed (the fetcher's host, size and time limits), parsed strictly, compared with `current`. */
export async function checkForUpdate(options: {
  channel: Channel;
  current: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
}): Promise<UpdateAnswer> {
  let bytes: Uint8Array;
  try {
    bytes = await fetchLimited(FEED_URLS[options.channel], {
      maxBytes: FEED_MAX_BYTES,
      timeoutMs: FEED_TIMEOUT_MS,
      userAgent: `pap/${options.current}`,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (error instanceof FetchRefused) throw new UpdateFeedError(error.code);
    throw error;
  }
  let parsed: ReturnType<typeof FeedSchema.safeParse>;
  try {
    parsed = FeedSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    throw new UpdateFeedError("feed_invalid");
  }
  if (!parsed.success) throw new UpdateFeedError("feed_invalid");
  if (parsed.data.channel !== options.channel) throw new UpdateFeedError("channel");
  const order = compareVersions(parsed.data.version, options.current);
  return { status: order > 0 ? "newer" : order === 0 ? "current" : "older", feed: parsed.data };
}

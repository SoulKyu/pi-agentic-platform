import { createHash } from "node:crypto";
import { PROJECT_URL } from "@pap/contracts";
import { parseArgs } from "node:util";
import type { Command } from "../run-cli.ts";
import { UsageError } from "../usage.ts";
import { cliIo } from "./cli-io.ts";
import type { Channel, Feed } from "../update/feed.ts";
import type { FetchLike } from "../update/fetch.ts";

const BASE = `${PROJECT_URL}/releases`;
export const STABLE_URL = `${BASE}/latest/download/pap-feed-stable.json`;
export const NEXT_URL = `${BASE}/download/next/pap-feed-next.json`;

export interface Fixture {
  readonly feed: Feed;
  readonly installer: Buffer;
  readonly archive: Buffer;
  readonly feedUrl: string;
}

/** A feed for `version` with the installer and archive it describes (sizes and hash match the bytes). */
export function fixture(
  options: {
    version?: string;
    channel?: Channel;
    releaseId?: string;
    installer?: string;
    minNode?: string;
  } = {},
): Fixture {
  const version = options.version ?? "1.1.0";
  const channel = options.channel ?? "stable";
  const releaseId = options.releaseId ?? `v${version}`;
  const installer = Buffer.from(options.installer ?? "#!/usr/bin/env bash\nexit 0\n");
  const archive = Buffer.from(`archive of ${releaseId}`);
  const base = `${BASE}/download/${releaseId}`;
  const feed: Feed = {
    format: 1,
    channel,
    version,
    releaseId,
    publishedAt: "2026-10-17T10:00:00.000Z",
    minNode: options.minNode ?? "22.12",
    notes: `${base}/notes.md`,
    installer: {
      name: `pap-install-${releaseId}.sh`,
      url: `${base}/pap-install-${releaseId}.sh`,
      size: installer.length,
      sha256: createHash("sha256").update(installer).digest("hex"),
    },
    archive: {
      name: `pap-${releaseId}-linux-x64.tar.gz`,
      url: `${base}/pap-${releaseId}-linux-x64.tar.gz`,
      size: archive.length,
    },
  };
  return { feed, installer, archive, feedUrl: channel === "stable" ? STABLE_URL : NEXT_URL };
}

export interface FakeFetch {
  readonly fetch: FetchLike;
  /** Every URL asked, in order. */
  readonly calls: string[];
}

/** Serves bytes (or a ready Response, or a thrown error) by exact URL; any other URL is a 404. */
export function fakeFetch(
  routes: Record<string, Uint8Array | string | (() => Response | Promise<Response>)>,
): FakeFetch {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (route === undefined) return new Response("not found", { status: 404 });
    if (typeof route === "function") return route();
    return new Response(route, { status: 200 });
  };
  return { fetch, calls };
}

/** Routes for one release: the feed and both assets. */
export function routesFor(f: Fixture): Record<string, Uint8Array | string> {
  return {
    [f.feedUrl]: JSON.stringify(f.feed),
    [f.feed.installer.url]: f.installer,
    [f.feed.archive.url]: f.archive,
  };
}

/** Runs a command like `runCli` does (flags parsed strictly); a thrown `CliError` becomes its exit code and `pap: message`. */
export async function runCmd(cmd: Command, args: string[], ioOptions: Parameters<typeof cliIo>[0] = {}) {
  const { io, stdout, stderr } = cliIo(ioOptions);
  const { values, positionals } = parseArgs({
    args,
    options: cmd.options,
    strict: true,
    allowPositionals: true,
  });
  let code: number;
  try {
    code = await cmd.run({ values, positionals, io });
  } catch (error) {
    const err = error as { name: string; exitCode?: number; message: string };
    if (error instanceof UsageError) {
      io.stderr.write(`pap: ${err.message}\n`);
      return { code: 64, out: stdout(), err: stderr(), io };
    }
    if (err.exitCode === undefined) throw error;
    code = err.exitCode;
    io.stderr.write(`pap: ${err.message}\n`);
  }
  return { code, out: stdout(), err: stderr(), io };
}

import type { Fetcher, FetchResult } from "../index.ts";

export const GSTATIC = "https://fonts.gstatic.com/s";

/** A woff2-looking body: the magic, then filler of the size asked for. */
export function woff2(size = 64, fill = 1): Buffer {
  const body = Buffer.alloc(Math.max(size, 4), fill);
  body.write("wOF2", 0, "latin1");
  return body;
}

export function face(url: string, over: { weight?: string; range?: string; subset?: string } = {}): string {
  return [
    over.subset ? `/* ${over.subset} */` : "",
    "@font-face {",
    "  font-family: 'Fake Sans';",
    "  font-style: normal;",
    `  font-weight: ${over.weight ?? "400"};`,
    "  font-display: swap;",
    `  src: url(${url}) format('woff2');`,
    over.range ? `  unicode-range: ${over.range};` : "",
    "}",
  ].join("\n");
}

export type Reply = FetchResult | Buffer | string;
export interface FakeFetcher extends Fetcher {
  readonly calls: Array<{ url: string; maxBytes: number }>;
}

/** Answers from a table of url prefix -> reply; a string or Buffer is a 200. Nothing here touches a network. */
export function fakeFetcher(table: Record<string, Reply>): FakeFetcher {
  const calls: FakeFetcher["calls"] = [];
  const fetcher = (async (url: string, maxBytes: number): Promise<FetchResult> => {
    calls.push({ url, maxBytes });
    const key = Object.keys(table).find((prefix) => url.startsWith(prefix));
    if (key === undefined) return { ok: false, error: "network" };
    const reply = table[key] as Reply;
    if (typeof reply === "string") return { ok: true, status: 200, body: Buffer.from(reply) };
    if (Buffer.isBuffer(reply)) return { ok: true, status: 200, body: reply };
    return reply;
  }) as FakeFetcher;
  return Object.assign(fetcher, { calls });
}

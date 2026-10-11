import { request as httpRequestNode } from "node:http";
import { request as httpsRequest } from "node:https";

export interface HttpReply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

// Node's `fetch` may refuse an explicit `Origin` header; `node:http` does not. A test daemon's own certificate is
// self-signed, so https replies are accepted without a trust check.
export function httpRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpReply> {
  const request = url.startsWith("https:") ? httpsRequest : httpRequestNode;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: init.method ?? "GET", headers: init.headers, rejectUnauthorized: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

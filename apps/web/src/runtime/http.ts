import { PROTOCOL_VERSION } from "@pap/contracts";
import type { ProbeResult } from "./connection.ts";

const PROBE_TIMEOUT_MS = 5_000;

export interface HttpResult<T> {
  readonly status: number;
  readonly body: T | null;
  readonly retryAfterSeconds: number | null;
}

async function read<T>(response: Response): Promise<HttpResult<T>> {
  const text = await response.text();
  let body: T | null;
  try {
    body = text ? (JSON.parse(text) as T) : null;
  } catch {
    body = null;
  }
  const retry = response.headers.get("retry-after");
  return { status: response.status, body, retryAfterSeconds: retry ? Number(retry) : null };
}

export async function getJson<T>(path: string): Promise<HttpResult<T>> {
  return read<T>(await fetch(path, { credentials: "same-origin" }));
}

export async function postJson<T>(path: string, body: unknown): Promise<HttpResult<T>> {
  return read<T>(
    await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
  );
}

// Browsers hide the status of a refused upgrade, so the supervisor asks this plain GET why the socket
// dropped. A network that swallows the request must not leave the supervisor waiting for the answer.
export async function probeServer(): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`/ws?proto=${PROTOCOL_VERSION}`, {
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (response.status === 426) return "outdated";
    if (response.status === 401) return "signed-out";
    return response.ok ? "ok" : "offline";
  } catch {
    return "offline";
  } finally {
    clearTimeout(timer);
  }
}

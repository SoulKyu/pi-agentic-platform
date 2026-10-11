import { PROTOCOL_VERSION } from "@pap/contracts";
import type { ProbeResult } from "./connection.ts";

const PROBE_ABORT_MS = 5_000;

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
  return {
    status: response.status,
    body,
    retryAfterSeconds: retryAfter(response.headers.get("retry-after")),
  };
}

// Retry-After is a number of seconds or an HTTP date.
function retryAfter(header: string | null): number | null {
  const value = header?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000));
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
  const timer = setTimeout(() => controller.abort(), PROBE_ABORT_MS);
  try {
    const response = await fetch(`/ws?proto=${PROTOCOL_VERSION}`, {
      credentials: "same-origin",
      cache: "no-store",
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

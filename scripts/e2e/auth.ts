// Owner setup, login and step-up through the HTTP API, for the fixtures. J01 does setup through the UI and uses none of it
// except `login` to give `pap.rpc` a session. The requests go to 127.0.0.1 with the page's origin in the `Origin` header
// (as scripts/smoke-dist.ts does): the daemon allows the origin `http://localhost:<port>`, the socket is the same.
import type { Page } from "@playwright/test";
import { http } from "../smoke-lib.ts";

export const SESSION_COOKIE = "pap_session";

export interface Credentials {
  readonly username: string;
  readonly password: string;
}
export interface Origin {
  readonly origin: string;
  readonly owner: Credentials;
}

const loopback = (origin: string): string => origin.replace("//localhost:", "//127.0.0.1:");

async function startSession(origin: string, path: string, body: object, expected: number): Promise<string> {
  const res = await http(`${loopback(origin)}${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== expected) throw new Error(`${path} answered ${res.status}, expected ${expected}`);
  const header = res.headers["set-cookie"];
  const first = (Array.isArray(header) ? header[0] : header) ?? "";
  const [pair] = first.split(";");
  if (!pair?.startsWith(`${SESSION_COOKIE}=`)) throw new Error(`${path} set no ${SESSION_COOKIE} cookie`);
  return pair.slice(SESSION_COOKIE.length + 1);
}

/** The one-time token of a setup address (`/#token=<token>`). */
export const setupToken = (setupUrl: string): string => new URL(setupUrl).hash.replace("#token=", "");

/** Creates the owner; resolves to the session cookie value. */
export const setupOwner = (origin: string, token: string, owner: Credentials): Promise<string> =>
  startSession(origin, "/auth/setup", { token, ...owner }, 201);

/** Signs the owner in; resolves to the session cookie value. */
export const login = (origin: string, owner: Credentials): Promise<string> =>
  startSession(origin, "/auth/login", owner, 200);

/** Confirms the owner password for the next five minutes, for the browser session of `page`. */
export async function stepUp(page: Page, pap: Origin): Promise<void> {
  const answer = await page.request.post(`${pap.origin}/auth/confirm`, {
    data: { password: pap.owner.password },
    headers: { origin: pap.origin },
  });
  if (answer.status() !== 204) throw new Error(`/auth/confirm answered ${answer.status()}, expected 204`);
}

import { isAbsolute, resolve } from "node:path";
import { within } from "../policy/target-path.ts";

const NPM = /^npm:(?:@[a-z0-9][a-z0-9._-]{0,99}\/)?[a-z0-9][a-z0-9._-]{0,99}(?:@[A-Za-z0-9._+-]{1,64})?$/;
const GIT = /^git:[A-Za-z0-9.-]{1,253}\/[A-Za-z0-9._/-]{1,200}(?:@[A-Za-z0-9._/-]{1,128})?$/;
const HTTPS = /^https:\/\/[A-Za-z0-9.-]{1,253}\/[A-Za-z0-9._/-]{1,200}$/;

const dotSegment = (segments: readonly string[]): boolean => segments.some((s) => s === "." || s === "..");

/** A host never starts or ends with `-` or `.` (an ssh option such as `-oProxyCommand`), and has a dot. */
const hostShape = (host: string): boolean => host.includes(".") && !/^[-.]|[-.]$/.test(host);

/** MC54: Pi reads `git:a/../x` as a local path and a ref `-x` as a flag, so: a dotted host, 2+ clean segments, a ref not starting with `-`. */
function gitShape(source: string): boolean {
  const [location = "", ref] = source.slice("git:".length).split("@");
  const [host = "", ...path] = location.split("/");
  return (
    hostShape(host) &&
    path.length >= 2 &&
    path.every((s) => s !== "") &&
    !dotSegment(path) &&
    !ref?.startsWith("-")
  );
}

/** MC54: no `.` or `..` path segment in an `https://` source. */
const httpsShape = (source: string): boolean => {
  const [host = "", ...path] = source.slice("https://".length).split("/");
  return hostShape(host) && !dotSegment(path);
};

/** M7R115: a package source Pi may install, or null. Local paths: absolute, inside `home` (never `home` itself), no `..` left after resolving. */
export function pluginSource(raw: string, home: string): string | null {
  const source = raw.trim();
  if (source.startsWith("-")) return null;
  if (
    NPM.test(source) ||
    (GIT.test(source) && gitShape(source)) ||
    (HTTPS.test(source) && httpsShape(source))
  )
    return source;
  if (/^(?:git:|https:\/\/)/.test(source)) return null;
  if (!isAbsolute(source) || source.includes("\0")) return null;
  const path = resolve(source);
  return within(home, path) && path !== resolve(home) && path === source.replace(/\/+$/, "") ? path : null;
}

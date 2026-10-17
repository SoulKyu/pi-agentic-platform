// The PWA files of the built web app, asked of the built daemon without a cookie (M12 J1): the manifest, its icons and the
// service worker are public static files; `/n/<id>` is a page of the single-page app (the landing), not a 404; and the
// worker never touches the health endpoint. Plain HTTP, like the rest of the smoke test.
import { http, step } from "./smoke-lib.ts";

const ID = "abcdefghijklmnopqrstuv";

async function fileOf(base: string, path: string, type: RegExp) {
  const reply = await http(`${base}${path}`);
  if (reply.status !== 200) throw new Error(`${path} answered ${reply.status} without a cookie`);
  const got = String(reply.headers["content-type"]);
  if (!type.test(got)) throw new Error(`${path} is ${got}, expected ${String(type)}`);
  return reply;
}

export async function checkPwa(base: string): Promise<void> {
  const manifest = await fileOf(base, "/manifest.webmanifest", /manifest\+json|application\/json/);
  const parsed = JSON.parse(manifest.body) as { display?: string; icons?: Array<{ src?: string }> };
  if (parsed.display !== "standalone") throw new Error(`the manifest display is ${String(parsed.display)}`);
  const icons = (parsed.icons ?? []).map((icon) => String(icon.src));
  if (icons.length === 0) throw new Error("the manifest lists no icon");
  for (const src of [...icons, "/icons/apple-touch-icon.png", "/icons/badge-96.png"])
    await fileOf(base, src, /^image\/png/);
  const worker = await fileOf(base, "/sw.js", /javascript/);
  if (String(worker.headers["cache-control"]).includes("immutable"))
    throw new Error("sw.js is served as immutable: a new worker would never be fetched");
  if (!worker.body.includes("/healthz"))
    throw new Error("the service worker does not name /healthz as never cached");
  const landing = await http(`${base}/n/${ID}`);
  const index = await http(`${base}/`);
  if (landing.status !== 200 || landing.body !== index.body)
    throw new Error(`/n/<id> answered ${landing.status}: it must be the single-page app, like /`);
  const health = await http(`${base}/healthz`);
  if (health.status !== 200 || health.body.includes("<html"))
    throw new Error("/healthz is not the daemon's own answer (the worker or the SPA fallback took it)");
  step("manifest, icons and sw.js are public, /n/<id> is the app, /healthz is the daemon's");
}

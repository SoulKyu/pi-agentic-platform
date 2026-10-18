import { createHash } from "node:crypto";
import { FONT_LIMITS, PapError, type Caller, type FontFamilyView } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { googleFamilyName, parseGoogleCss, type GoogleFace } from "./css.ts";
import { canonicalFamily, slugOf, validFamily } from "./family.ts";
import type { Fetcher, FetchError } from "./google-fetch.ts";
import type { FontsStore, StoredFamily } from "./store.ts";

export interface FontsServiceDeps {
  readonly store: FontsStore;
  readonly fetch: Fetcher;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface FontsService {
  list(caller: Caller): { families: FontFamilyView[] };
  add(caller: Caller, family: string): Promise<FontFamilyView>;
  remove(caller: Caller, slug: string): { ok: true };
}

/** Every `fonts.*` method is for a browser session, checked before any read, download or write; a token learns nothing. */
function requireBrowser(caller: Caller): void {
  if (caller.kind !== "session") throw new PapError("forbidden");
}

const viewOf = (entry: StoredFamily): FontFamilyView => ({
  slug: entry.slug,
  family: entry.family,
  files: entry.files.length,
  bytes: entry.bytes,
  addedAt: entry.addedAt,
});

/** The cause (never a URL) rides on the error's standard `cause`, for the log line only. */
const failure = (code: "network" | "payload_too_large", cause: string): PapError =>
  Object.assign(new PapError(code), { cause });
const fetchFailure = (error: FetchError): PapError =>
  failure(error === "too_large" ? "payload_too_large" : "network", error);

const cssUrl = (family: string, weights: boolean): string =>
  `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}${weights ? ":wght@400;500;600;700" : ""}&display=swap`;

/** One `fonts.add` may take this long in all (each request is also bounded by its own 15 s). */
export const INSTALL_DEADLINE_MS = 60_000;
/** One install runs and one waits; a third is refused. */
const MAX_PENDING_INSTALLS = 2;
type Get = (url: string, maxBytes: number) => ReturnType<Fetcher>;

const MAGIC = "wOF2";
const LATIN = new Set(["latin", "latin-ext"]);
const uniqueUrls = (faces: readonly GoogleFace[]): string[] => [...new Set(faces.map((face) => face.url))];

/** The four weights first; a family that does not offer them (a single-weight font) is asked for again as itself. */
async function stylesheet(deps: FontsServiceDeps, family: string, get: Get): Promise<string> {
  for (const weights of [true, false]) {
    const answer = await get(cssUrl(family, weights), FONT_LIMITS.cssBytes);
    if (!answer.ok) throw fetchFailure(answer.error);
    if (answer.status === 200) return answer.body.toString("utf8");
    if (answer.status !== 400 && answer.status !== 404) throw failure("network", "status");
  }
  throw new PapError("not_found");
}

/** Past the file cap, a family keeps the Latin subsets (the bundled fonts are Latin only); still over the cap is refused. */
function withinCap(faces: GoogleFace[]): GoogleFace[] {
  if (uniqueUrls(faces).length <= FONT_LIMITS.filesPerFamily) return faces;
  const latin = faces.filter((face) => face.subset !== null && LATIN.has(face.subset));
  if (latin.length === 0 || uniqueUrls(latin).length > FONT_LIMITS.filesPerFamily)
    throw new PapError("payload_too_large");
  return latin;
}

async function download(
  get: Get,
  urls: readonly string[],
): Promise<{ names: Map<string, string>; bodies: Map<string, Buffer> }> {
  const names = new Map<string, string>();
  const bodies = new Map<string, Buffer>();
  for (const url of urls) {
    const answer = await get(url, FONT_LIMITS.fileBytes);
    if (!answer.ok) throw fetchFailure(answer.error);
    if (answer.status !== 200) throw failure("network", "status");
    const body = answer.body;
    if (body.length > FONT_LIMITS.fileBytes) throw new PapError("payload_too_large");
    if (body.length < 4 || body.toString("latin1", 0, 4) !== MAGIC) throw failure("network", "magic");
    const name = `${createHash("sha256").update(body).digest("hex").slice(0, 16)}.woff2`;
    names.set(url, name);
    bodies.set(name, body);
  }
  return { names, bodies };
}

function generatedCss(
  family: string,
  slug: string,
  faces: readonly GoogleFace[],
  names: ReadonlyMap<string, string>,
): string {
  return `${faces
    .map((face) =>
      [
        "@font-face {",
        `font-family: "${family}";`,
        "font-style: normal;",
        `font-weight: ${face.weight};`,
        "font-display: swap;",
        `src: url("/fonts/${slug}/${names.get(face.url) ?? ""}") format("woff2");`,
        ...(face.unicodeRange === null ? [] : [`unicode-range: ${face.unicodeRange};`]),
        "}",
      ].join(" "),
    )
    .join("\n")}\n`;
}

export function createFontsService(deps: FontsServiceDeps): FontsService {
  const { store, logger } = deps;
  let queue: Promise<unknown> = Promise.resolve(); // one install at a time: the family cap cannot be raced
  let pending = 0;

  async function install(typed: string): Promise<FontFamilyView> {
    const start = deps.clock.now();
    // Each request gets what is left of the overall deadline (and never more than its own 15 s).
    const get: Get = (url, maxBytes) => {
      const left = INSTALL_DEADLINE_MS - (deps.clock.now() - start);
      return left <= 0
        ? Promise.reject(failure("network", "deadline"))
        : deps.fetch(url, maxBytes, Math.min(left, 15_000));
    };
    const slug = slugOf(typed);
    const present = store.get(slug);
    if (present !== null) return viewOf(present);
    if (store.list().length >= FONT_LIMITS.families) throw new PapError("limit_reached");
    const css = await stylesheet(deps, typed, get);
    const faces = withinCap(parseGoogleCss(css).faces);
    if (faces.length === 0) throw new PapError("not_found");
    const family = googleFamilyName(css, typed);
    const urls = uniqueUrls(faces);
    const { names, bodies } = await download(get, urls);
    const stored = store.install(
      { slug, family, addedAt: deps.clock.now() },
      generatedCss(family, slug, faces, names),
      bodies,
    );
    logger.info("font_added", { family, files: stored.files.length, bytes: stored.bytes });
    return viewOf(stored);
  }

  return {
    list(caller) {
      requireBrowser(caller);
      return { families: store.list().map(viewOf) };
    },
    async add(caller, family) {
      requireBrowser(caller);
      if (!validFamily(family)) throw new PapError("bad_request");
      // Two installs already running (one downloading, one waiting): a third is refused, not queued behind them.
      if (pending >= MAX_PENDING_INSTALLS) {
        logger.warn("font_install_busy", { pending });
        throw new PapError("limit_reached");
      }
      pending += 1;
      const typed = canonicalFamily(family);
      const run = queue
        .then(() => install(typed))
        .catch((error: unknown) => {
          if (error instanceof PapError && error.code === "network")
            logger.warn("font_fetch_failed", { family: typed, cause: String(error.cause ?? "unknown") });
          throw error;
        });
      const done = () => {
        pending -= 1;
      };
      queue = run.then(done, done);
      return run;
    },
    remove(caller, slug) {
      requireBrowser(caller);
      if (!store.remove(slug)) throw new PapError("not_found");
      logger.info("font_removed", { slug });
      return { ok: true };
    },
  };
}

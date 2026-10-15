import { createHash } from "node:crypto";

export interface FeedEntry {
  /** sha256 (hex) of the entry's id, else its link, else its title. */
  readonly key: string;
  readonly title: string;
  readonly link: string | null;
  readonly date: string | null;
  readonly summary: string;
}
export type FeedParse = { ok: true; entries: FeedEntry[] } | { ok: false; code: "not_a_feed" };

/** What a hostile document can make the parser read or build (M10R75). */
export const FEED_LIMITS = {
  entries: 100,
  titleChars: 300,
  summaryChars: 1_024,
  idChars: 1_024,
  linkChars: 2_048,
  dateChars: 64,
  /** The raw text kept per field before cleaning: enough for a summary whose first part is markup. */
  rawChars: 16_384,
  depth: 32,
  nodes: 20_000,
  tagChars: 4_096,
} as const;

// A DTD or an entity declaration anywhere (comments and CDATA included) refuses the document: nothing is ever expanded.
const DECLARATION = /<!\s*(?:DOCTYPE|ENTITY)/i;
const ENTITY = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g;
const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
// Format characters (bidi, zero-width, tags), C0 and C1 controls but tab and line feed, lone surrogates, private use.
const HIDDEN = /[\p{Cf}\p{Cs}\p{Co}]|(?![\t\n])\p{Cc}/gu;
const ROOTS: ReadonlySet<string> = new Set(["rss", "feed", "rdf:RDF"]);
const FIELDS: ReadonlySet<string> = new Set([
  "title",
  "link",
  "id",
  "guid",
  "published",
  "updated",
  "pubDate",
  "dc:date",
  "summary",
  "description",
  "content",
]);

function decode(text: string): string {
  return text.replace(ENTITY, (whole, body: string) => {
    if (body[0] !== "#") return NAMED[body] ?? whole;
    const code =
      body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
    const allowed =
      code === 9 || code === 10 || (code >= 0x20 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff));
    return allowed ? String.fromCodePoint(code) : "";
  });
}

/** One visible line: hidden characters gone, every run of white space one space, at most `max` characters. */
function clean(text: string | undefined, max: number): string {
  if (text === undefined) return "";
  const bounded = text.length > max * 4 ? text.slice(0, max * 4) : text;
  return [...bounded.replace(HIDDEN, "").replace(/\s+/g, " ").trim()].slice(0, max).join("");
}

/** Tags out of a summary, in one pass: a `<` with no `>` after it is text, and nothing is rescanned. */
function stripTags(text: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = text.indexOf("<", from);
    if (open === -1) break;
    const close = text.indexOf(">", open + 1);
    if (close === -1) break;
    out += `${text.slice(from, open)} `;
    from = close + 1;
  }
  return out + text.slice(from);
}

const isoOrRaw = (raw: string): string | null => {
  const text = clean(raw, FEED_LIMITS.dateChars);
  if (text === "") return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : text;
};

const webLink = (raw: string | undefined): string | null => {
  const text = clean(raw, FEED_LIMITS.linkChars);
  return /^https?:\/\//i.test(text) ? text : null;
};

/** The `href` and `rel` of a `<link .../>`: a linear scan of the tag, never a regular expression over attacker text. */
function linkAttributes(rest: string): { href: string | null; rel: string | null } {
  const found: Record<"href" | "rel", string | null> = { href: null, rel: null };
  let at = 0;
  const n = rest.length;
  while (at < n) {
    while (at < n && /\s/.test(rest.charAt(at))) at++;
    const start = at;
    while (at < n && !/[\s=/]/.test(rest.charAt(at))) at++;
    const name = rest.slice(start, at);
    while (at < n && /\s/.test(rest.charAt(at))) at++;
    if (rest.charAt(at) !== "=") {
      if (at === start) at++;
      continue;
    }
    at++;
    while (at < n && /\s/.test(rest.charAt(at))) at++;
    const quote = rest.charAt(at);
    if (quote !== '"' && quote !== "'") continue;
    const end = rest.indexOf(quote, at + 1);
    if (end === -1) break;
    if (name === "href" || name === "rel") found[name] = decode(rest.slice(at + 1, end));
    at = end + 1;
  }
  return found;
}

/** The `>` that ends the tag opened at `from`, skipping quoted values; -1 when there is none. */
function tagEnd(xml: string, from: number): number {
  let quote = "";
  for (let at = from; at < xml.length; at++) {
    const char = xml.charAt(at);
    if (quote !== "") {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return at;
  }
  return -1;
}

interface Draft {
  readonly fields: Map<string, string>;
  readonly links: Array<{ href: string; rel: string | null }>;
}

function entryOf(draft: Draft): FeedEntry | null {
  const { fields } = draft;
  const title = clean(fields.get("title"), FEED_LIMITS.titleChars);
  const alternate =
    draft.links.find((link) => link.rel === null || link.rel === "" || link.rel === "alternate") ??
    draft.links[0];
  const link = webLink(alternate?.href ?? fields.get("link"));
  const id = clean(fields.get("id") ?? fields.get("guid"), FEED_LIMITS.idChars);
  const source = id !== "" ? id : (link ?? title);
  if (source === "") return null;
  const date = ["published", "updated", "pubDate", "dc:date"]
    .map((name) => fields.get(name))
    .find((v) => v !== undefined);
  const summary = fields.get("summary") ?? fields.get("description") ?? fields.get("content");
  return {
    key: createHash("sha256").update(source).digest("hex"),
    title,
    link,
    date: date === undefined ? null : isoOrRaw(date),
    summary: clean(summary === undefined ? undefined : stripTags(summary), FEED_LIMITS.summaryChars),
  };
}

const NOT_A_FEED = { ok: false, code: "not_a_feed" } as const;

/**
 * RSS 2.0, RSS 1.0 and Atom, read by one linear pass over the text (M10R75). No XML library: a DOCTYPE or an ENTITY
 * anywhere refuses the document, only the five entities and numeric references are decoded (once), the depth and the
 * number of elements are capped, and only the direct children of an entry are read. A malformed document is not a feed.
 */
export function parseFeed(xml: string): FeedParse {
  const text = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  if (DECLARATION.test(text)) return NOT_A_FEED;
  const stack: string[] = [];
  const entries: FeedEntry[] = [];
  let nodes = 0;
  let draft: Draft | null = null;
  let entryDepth = 0;
  let capture: { name: string; text: string } | null = null;

  const append = (chunk: string, raw: boolean): void => {
    if (capture === null) return;
    const room = FEED_LIMITS.rawChars - capture.text.length;
    if (room > 0) capture.text += raw ? chunk.slice(0, room) : decode(chunk.slice(0, room));
  };

  let at = 0;
  while (at < text.length) {
    const open = text.indexOf("<", at);
    if (open === -1) {
      append(text.slice(at), false);
      break;
    }
    if (open > at) append(text.slice(at, open), false);
    if (text.startsWith("<!--", open)) {
      const end = text.indexOf("-->", open + 4);
      if (end === -1) return NOT_A_FEED;
      at = end + 3;
    } else if (text.startsWith("<![CDATA[", open)) {
      const end = text.indexOf("]]>", open + 9);
      if (end === -1) return NOT_A_FEED;
      append(text.slice(open + 9, end), true);
      at = end + 3;
    } else if (text.startsWith("<?", open)) {
      const end = text.indexOf("?>", open + 2);
      if (end === -1) return NOT_A_FEED;
      at = end + 2;
    } else if (text.startsWith("<!", open)) {
      return NOT_A_FEED;
    } else {
      const end = tagEnd(text, open + 1);
      if (end === -1) return NOT_A_FEED;
      at = end + 1;
      if (text.charAt(open + 1) === "/") {
        const name = text.slice(open + 2, end).trim();
        if (stack.pop() !== name) return NOT_A_FEED;
        if (capture !== null && draft !== null && stack.length === entryDepth && capture.name === name) {
          if (!draft.fields.has(name)) draft.fields.set(name, capture.text);
          capture = null;
        }
        if (draft !== null && stack.length === entryDepth - 1) {
          const entry = entryOf(draft);
          if (entry !== null) entries.push(entry);
          draft = null;
          if (entries.length >= FEED_LIMITS.entries) return { ok: true, entries };
        }
        continue;
      }
      const inner = text.slice(open + 1, end);
      const selfClosing = inner.endsWith("/");
      const split = inner.search(/[\s/]/);
      const name = split === -1 ? inner : inner.slice(0, split);
      if (name === "" || ++nodes > FEED_LIMITS.nodes) return NOT_A_FEED;
      if (stack.length === 0 && !ROOTS.has(name)) return NOT_A_FEED;
      if (stack.length >= FEED_LIMITS.depth) return NOT_A_FEED;
      stack.push(name);
      if (draft === null && (name === "item" || name === "entry") && stack.length <= 4) {
        draft = { fields: new Map(), links: [] };
        entryDepth = stack.length;
      } else if (draft !== null && stack.length === entryDepth + 1 && FIELDS.has(name)) {
        if (name === "link" && inner.length <= FEED_LIMITS.tagChars && inner.includes("href")) {
          const { href, rel } = linkAttributes(inner.slice(name.length));
          if (href !== null) draft.links.push({ href, rel });
        } else capture = { name, text: "" };
      }
      if (selfClosing) {
        stack.pop();
        if (capture !== null && draft !== null && stack.length === entryDepth && capture.name === name) {
          draft.fields.set(name, capture.text);
          capture = null;
        }
        if (draft !== null && stack.length === entryDepth - 1) draft = null;
      }
    }
  }
  return stack.length === 0 && nodes > 0 ? { ok: true, entries } : NOT_A_FEED;
}

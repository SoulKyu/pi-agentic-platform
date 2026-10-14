import { LONE_SURROGATE } from "../text.ts";

const NAME_CODE_POINTS = 64;
/** An extension kept through the cut: a dot, then 1 to 15 letters or digits (`.tar.gz` keeps `.gz`). */
const EXTENSION = /\.[\p{L}\p{N}]{1,15}$/u;
// Characters a file system or a header has a use for, and format and control characters (bidi marks among them).
const UNSAFE_IN_NAME = /[\\/:*?"<>|]|[\p{Cc}\p{Cf}]/gu;
const ASCII_SAFE = /[A-Za-z0-9 ._-]/;

export interface DispositionOptions {
  /** The name when nothing usable is left (without the suffix). */
  readonly fallback: string;
  /** Appended after the cut: `.html` for an export; `""` for a raw file, whose own extension survives the cut instead. */
  readonly suffix: string;
  /** An export drops leading dots and blanks; a raw file turns one leading dot into `_`, so `.env` stays `_env` (RT-20). */
  readonly leadingDot: "strip" | "underscore";
}

function cut(name: string, keepExtension: boolean): string {
  const points = [...name];
  if (points.length <= NAME_CODE_POINTS) return name;
  const extension = keepExtension ? (EXTENSION.exec(name)?.[0] ?? "") : "";
  const tail = [...extension];
  return (
    points
      .slice(0, NAME_CODE_POINTS - tail.length)
      .join("")
      .trimEnd() + extension
  );
}

/**
 * `Content-Disposition` of a download, always an attachment (ADR 0006, M8R32): an ASCII fallback (`filename`: no
 * quote, separator or control character can be in it) and the RFC 5987 form (`filename*`, percent-encoded UTF-8).
 */
export function attachmentDisposition(name: string | null | undefined, options: DispositionOptions): string {
  const stripped = (name ?? "")
    .replace(LONE_SURROGATE, "�")
    .replace(UNSAFE_IN_NAME, (found) => (/^[\p{Cc}\p{Cf}]$/u.test(found) ? "" : "_"));
  const led =
    options.leadingDot === "strip" ? stripped.replace(/^[.\s]+/u, "") : stripped.replace(/^\./u, "_");
  const clean = cut(led.trim(), options.suffix === "").trimEnd();
  if (clean === "") return `attachment; filename="${options.fallback}${options.suffix}"`;
  const ascii = [...clean].map((char) => (ASCII_SAFE.test(char) ? char : "_")).join("");
  const asciiName = /[A-Za-z0-9]/.test(ascii) ? ascii : options.fallback;
  const encoded = encodeURIComponent(`${clean}${options.suffix}`).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiName}${options.suffix}"; filename*=UTF-8''${encoded}`;
}

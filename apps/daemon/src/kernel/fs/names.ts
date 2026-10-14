import { INVISIBLE } from "@pap/contracts";
import { isTempName } from "./safe-open.ts";

/** A file name a client may create: one segment, NFC, visible characters, no surrounding blanks, ≤ 255 bytes. */
export function uploadName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFC");
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")) return null;
  if (
    /\p{Surrogate}/u.test(name) ||
    isTempName(name) ||
    name !== name.trim() ||
    INVISIBLE.test(name) ||
    // MC9: Hangul fillers, variation selectors, soft hyphen and the like render blank; the shared list stays as it is.
    /\p{Default_Ignorable_Code_Point}/u.test(name) ||
    Buffer.byteLength(name) > 255
  )
    return null;
  return name;
}

import { UI_LIMITS } from "@pap/contracts";
import { cleanLabel } from "../../kernel/text.ts";

/**
 * The one clip of a session name (M2R92): Pi's name comes from the Pi CLI, an extension or the model, so it may be
 * long or hold control or bidi characters. The database (`length(name) <= 256`), the contract (`SessionName`) and the
 * list all accept what this returns. Whitespace of any kind becomes one space; the other control and format
 * characters are removed (the joiner of emoji sequences is kept).
 */
export const nameOf = (raw: unknown): string | null => cleanLabel(raw, UI_LIMITS.name);

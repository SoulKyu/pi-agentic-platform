import { sha256Hex } from "../../kernel/ids.ts";

/** The key of one browser session: the hash of its id hash, never the cookie (M5R127). */
export const sessionKey = (cookieValue: string): string =>
  `session:${sha256Hex(sha256Hex(cookieValue)).slice(0, 32)}`;

import { createHash } from "node:crypto";

/** SHA-256 of a stored endpoint (hex): the only thing the database and the logs keep of it besides the row itself. */
export const hashOf = (href: string): string => createHash("sha256").update(href).digest("hex");
/** What logs and the audit show of an endpoint: never the endpoint itself. */
export const shortHash = (hash: string): string => `h:${hash.slice(0, 12)}`;
/** The log tag of an endpoint, for both chains: `h:` and 12 hex of its SHA-256. */
export const endpointTag = (href: string): string => shortHash(hashOf(href));

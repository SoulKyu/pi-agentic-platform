import { createHash, randomBytes, randomUUID } from "node:crypto";

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
export const sha256Hex = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export const newId = (): string => randomUUID();

export const ERROR_CODES = [
  "bad_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "payload_too_large",
  "capacity",
  "worker_failed",
  "prompt_rejected",
  "invalid_cwd",
  "read_only",
  "unknown_method",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_MESSAGES: { readonly [C in ErrorCode]: string } = {
  bad_request: "The request is invalid.",
  unauthenticated: "Sign in first.",
  forbidden: "You do not have permission for this action.",
  not_found: "Not found.",
  conflict: "This already exists or changed meanwhile.",
  rate_limited: "Too many attempts. Try again later.",
  payload_too_large: "The request is too large.",
  capacity: "The server is at capacity. Try again later.",
  worker_failed: "The session process failed.",
  prompt_rejected: "The session could not start this prompt. Check the model and provider settings.",
  invalid_cwd: "The working directory must be an absolute path to an existing folder.",
  read_only: "The database was written by a newer version and is read-only.",
  unknown_method: "Unknown method.",
  internal: "Internal error.",
};

export class PapError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "PapError";
    this.code = code;
  }
}

import { AttachmentView, ERROR_CODES, FILE_LIMITS, UploadAnswer, type ErrorCode } from "@pap/contracts";

/**
 * Why an upload failed: a server code, or one of the client's own. `offline`: the browser reports itself offline.
 * `interrupted`: the upload stopped before the end (shown with the `upload.interrupted` copy, M8R106); never an `ERROR_CODES` entry.
 */
export type UploadErrorCode = ErrorCode | "offline" | "interrupted";

export class UploadError extends Error {
  readonly code: UploadErrorCode;

  constructor(code: UploadErrorCode) {
    super(code);
    this.name = "UploadError";
    this.code = code;
  }
}

const STATUS_CODES: Readonly<Record<number, ErrorCode>> = {
  400: "bad_request",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  503: "capacity",
};

function codeOf(status: number, body: unknown): ErrorCode {
  const named = (body as { error?: { code?: unknown } } | null)?.error?.code;
  if (typeof named === "string" && (ERROR_CODES as readonly string[]).includes(named)) {
    return named as ErrorCode;
  }
  return STATUS_CODES[status] ?? "internal";
}

async function send<T>(
  url: string,
  init: RequestInit,
  file: Pick<File, "size">,
  parse: (body: unknown) => T | null,
): Promise<T> {
  // The server refuses the same file before it reads a byte; saying so here saves the transfer.
  if (file.size > FILE_LIMITS.uploadBytes) throw new UploadError("payload_too_large");
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: "same-origin" });
  } catch (error) {
    // The caller's own abort is theirs to handle, not an interrupted upload.
    if (init.signal?.aborted) throw error;

    throw new UploadError(navigator.onLine === false ? "offline" : "interrupted");
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch (error) {
    if (init.signal?.aborted) throw error;
    // an empty or non-JSON body: the status alone tells the story
  }
  if (!response.ok) throw new UploadError(codeOf(response.status, body));
  const parsed = parse(body);
  if (parsed === null) throw new UploadError("internal");
  return parsed;
}

/** `POST /upload` (M8R37): a pending attachment of a session. */
export function uploadAttachment(
  sessionId: string,
  file: File,
  signal: AbortSignal,
): Promise<AttachmentView> {
  const url = `/upload?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(file.name)}`;
  return send(url, { method: "POST", body: file, signal }, file, (body) => {
    const parsed = AttachmentView.safeParse(body);
    return parsed.success ? parsed.data : null;
  });
}

export interface UploadFileOptions {
  readonly conflict: "skip" | "replace";
  readonly confirmProtected?: boolean;
  readonly signal: AbortSignal;
}

/** `PUT /files/raw` (M8R34): one explorer upload to an absolute path. */
export function uploadFile(path: string, file: File, options: UploadFileOptions): Promise<UploadAnswer> {
  const confirm = options.confirmProtected === true ? "&confirmProtected=1" : "";
  const url = `/files/raw?path=${encodeURIComponent(path)}&conflict=${options.conflict}${confirm}`;
  return send(url, { method: "PUT", body: file, signal: options.signal }, file, (body) => {
    const parsed = UploadAnswer.safeParse(body);
    return parsed.success ? parsed.data : null;
  });
}

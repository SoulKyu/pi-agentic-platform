import { PapError } from "@pap/contracts";
import type { Hono } from "hono";
import { uploadName } from "../../kernel/fs/names.ts";
import { BoundaryError } from "../../kernel/fs/safe-open.ts";
import type { HttpCaller } from "../../kernel/http/caller.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AttachmentsStore } from "./attachments-store.ts";
import { createInflight } from "./inflight.ts";
import { receiveBody } from "./receive-body.ts";
import { UPLOAD_MAX_BYTES } from "./upload.ts";
import { refuse } from "./upload-http.ts";

/** Uploads of one owner in flight at once (M8R106). */
const MAX_INFLIGHT_PER_OWNER = 4;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * `POST /upload?sessionId=<id>&name=<name>` (M8R37): sessions:operate, cookie only. Every refusal comes before the body is
 * read, in the order of the ruling; the declared length is reserved against the owner's budget before the first byte.
 * The session id is only recorded here: its owner is checked when the upload is claimed.
 */
export function mountAttachmentsRoute(
  app: Hono,
  deps: {
    readonly caller: HttpCaller;
    readonly store: AttachmentsStore;
    readonly logger: Logger;
    readonly readOnly: boolean;
  },
): void {
  const inflight = createInflight(MAX_INFLIGHT_PER_OWNER);
  app.post("/upload", async (c) => {
    const caller = deps.caller(c, "sessions:operate");
    if (caller instanceof Response) return caller;
    if (deps.readOnly) return refuse(c, "read_only");
    const leave = inflight.enter(caller.userId);
    if (leave === null) return refuse(c, "capacity");
    try {
      const body = receiveBody(c, UPLOAD_MAX_BYTES);
      if (body instanceof Response) {
        body.headers.set("connection", "close");
        return body;
      }
      const name = uploadName(c.req.query("name"));
      const sessionId = c.req.query("sessionId");
      if (name === null || sessionId === undefined || !SESSION_ID.test(sessionId))
        return refuse(c, "bad_request");
      let interrupted = false;
      const chunks = (async function* () {
        try {
          yield* body.chunks;
        } catch (error) {
          if (!(error instanceof BoundaryError)) interrupted = true;
          throw error;
        }
      })();
      try {
        const reservation = deps.store.reserve(caller.userId, body.length);
        return c.json(await deps.store.put(caller.userId, reservation, { sessionId, name, chunks }), 201);
      } catch (error) {
        if (interrupted) {
          deps.logger.info("upload_interrupted", {});
          return refuse(c, "bad_request");
        }
        if (error instanceof PapError) return refuse(c, error.code);
        throw error;
      }
    } finally {
      leave();
    }
  });
}

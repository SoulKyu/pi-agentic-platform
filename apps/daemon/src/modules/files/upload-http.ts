import { PapError } from "@pap/contracts";
import type { Context, Hono } from "hono";
import { BoundaryError } from "../../kernel/fs/safe-open.ts";
import type { HttpCaller } from "../../kernel/http/caller.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createInflight } from "./inflight.ts";
import { receiveBody } from "./receive-body.ts";
import { UPLOAD_MAX_BYTES, type UploadService } from "./upload.ts";

/** Uploads of one owner in flight at once (M8R106). */
const MAX_INFLIGHT_PER_OWNER = 4;

const STATUS: Readonly<Record<string, 400 | 403 | 404 | 409 | 413 | 503>> = {
  bad_request: 400,
  forbidden: 403,
  step_up_required: 403,
  not_found: 404,
  conflict: 409,
  limit_reached: 409,
  protected_path: 409,
  payload_too_large: 413,
  read_only: 503,
  capacity: 503,
};

/** An answer sent before the body is read closes the connection: the rest of the body is not worth receiving. */
export function refuse(c: Context, code: string) {
  c.header("connection", "close");
  return c.json({ error: { code } }, STATUS[code] ?? 400);
}

/**
 * `PUT /files/raw?path=<abs>&conflict=skip|replace[&confirmProtected=1]` (M8R34): one file per request, the body counted
 * while streamed. The route authenticates, decodes, calls the service and maps its error; every refusal comes before the body.
 */
export function mountUploadRoute(
  app: Hono,
  deps: {
    readonly caller: HttpCaller;
    readonly service: UploadService;
    readonly logger: Logger;
  },
): void {
  const inflight = createInflight(MAX_INFLIGHT_PER_OWNER);
  app.put("/files/raw", async (c) => {
    const caller = deps.caller(c, "files:operate");
    if (caller instanceof Response) return caller;
    if (deps.service.readOnly) return refuse(c, "read_only");
    const leave = inflight.enter(caller.userId);
    if (leave === null) return refuse(c, "capacity");
    try {
      const path = c.req.query("path");
      const conflict = c.req.query("conflict");
      if (path === undefined || (conflict !== "skip" && conflict !== "replace"))
        return refuse(c, "bad_request");
      const body = receiveBody(c, UPLOAD_MAX_BYTES);
      if (body instanceof Response) {
        body.headers.set("connection", "close");
        return body;
      }
      let interrupted = false;
      const chunks = (async function* () {
        try {
          let first = true;
          for await (const chunk of body.chunks) {
            if (first) deps.logger.debug("upload_started", { length: body.length });
            first = false;
            yield chunk;
          }
        } catch (error) {
          if (!(error instanceof BoundaryError)) interrupted = true;
          throw error;
        }
      })();
      try {
        const done = await deps.service.upload(caller, {
          path,
          conflict,
          confirmProtected: c.req.query("confirmProtected") === "1",
          chunks,
        });
        return c.json(done);
      } catch (error) {
        if (interrupted) {
          deps.logger.info("upload_interrupted", {});
          return refuse(c, "bad_request");
        }
        if (error instanceof PapError && error.code in STATUS) return refuse(c, error.code);
        throw error;
      }
    } finally {
      leave();
    }
  });
}

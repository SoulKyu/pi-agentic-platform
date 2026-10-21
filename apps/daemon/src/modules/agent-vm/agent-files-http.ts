import { AGENT_FILE_LIMITS, AgentFilePath, AgentId, PapError } from "@pap/contracts";
import type { Hono } from "hono";
import { BoundaryError } from "../../kernel/fs/safe-open.ts";
import type { HttpCaller } from "../../kernel/http/caller.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createInflight, receiveBody, refuse } from "../files/index.ts";
import type { AgentFilesService } from "./agent-files-service.ts";

/** Imports of one owner in flight at once. */
const MAX_INFLIGHT_PER_OWNER = 2;

/**
 * `PUT /agent-files?agentId=<id>&path=<path in the agent's home>` (sub-project 2, spec 7): agents:admin, cookie only like
 * `POST /upload` (a bearer is refused, the app's Origin guard covers CSRF). The refusals come in this order, all before a byte
 * of the body is read: session, query, the agent's owner, the declared length (at most 1 MiB). The body is then counted as it
 * arrives; a body longer than declared or a dropped connection writes nothing.
 */
export function mountAgentFilesRoute(
  app: Hono,
  deps: { readonly caller: HttpCaller; readonly service: AgentFilesService; readonly logger: Logger },
): void {
  const inflight = createInflight(MAX_INFLIGHT_PER_OWNER);
  app.put("/agent-files", async (c) => {
    const caller = deps.caller(c, "agents:admin");
    if (caller instanceof Response) return caller;
    const agentId = AgentId.safeParse(c.req.query("agentId"));
    const path = AgentFilePath.safeParse(c.req.query("path"));
    if (!agentId.success || !path.success) return refuse(c, "bad_request");
    const leave = inflight.enter(caller.userId);
    if (leave === null) return refuse(c, "capacity");
    try {
      deps.service.check(caller, agentId.data);
      const body = receiveBody(c, AGENT_FILE_LIMITS.maxBytes);
      if (body instanceof Response) {
        body.headers.set("connection", "close");
        return body;
      }
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of body.chunks) chunks.push(Buffer.from(chunk));
      } catch (error) {
        if (error instanceof BoundaryError) return refuse(c, "bad_request");
        deps.logger.info("agent_file_upload_interrupted", {});
        return refuse(c, "bad_request");
      }
      return c.json(deps.service.put(caller, agentId.data, path.data, Buffer.concat(chunks)));
    } catch (error) {
      if (error instanceof PapError) return refuse(c, error.code);
      throw error;
    } finally {
      leave();
    }
  });
}

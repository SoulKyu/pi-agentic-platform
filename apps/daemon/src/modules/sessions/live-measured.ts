import { type PiEvent, SERVER_CODES, type SessionStreamEvent } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import type { RateLimiter } from "../../kernel/rate-limit.ts";
import { clip } from "./worker-text.ts";

/** The socket allows 1 MiB per frame; an event is sent whole or not at all. */
const MAX_EVENT_BYTES = 1_000_000;

export interface MeasuredPublishContext {
  readonly publish: (event: SessionStreamEvent) => void;
  readonly emit: (event: SessionStreamEvent) => void;
  readonly limiter: RateLimiter;
  readonly logger: Logger;
}

/** Moved out of `live-session.ts` as is: the stream's own frame for a Pi event. */
export function createMeasuredPublish(context: MeasuredPublishContext): (event: PiEvent) => boolean {
  const { limiter, logger, emit } = context;
  // An event is sent whole or not at all, and every kind of event is measured: a `text_end` carries the whole text of
  // a block and a `toolcall_end` the whole call, so a delta is the only small one and it costs nothing to look.
  /** The stream's own frame for a Pi event, whole or not at all; false when it was too large and left out. */
  return function publishMeasured(event: PiEvent): boolean {
    if (Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) {
      const said = limiter.check("event_too_large");
      if (said.allowed) {
        logger.warn("pi_event_too_large", { type: clip(event.type), suppressed: said.suppressed });
        emit({
          kind: "notice",
          level: "warning",
          text: "A message was too large to stream.",
          code: SERVER_CODES.messageTooLarge,
        });
      }
      return false;
    }
    context.publish({ kind: "pi", event });
    return true;
  };
}

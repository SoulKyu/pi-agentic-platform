import { z } from "zod";

/** Unacknowledged bytes one side of a tunnel may have in flight before it stops reading (UX-2 §6: the terminals' rule). */
export const TUNNEL_WINDOW_BYTES = 1024 * 1024;
/** Raw bytes in one `tunnel_data` frame. */
export const TUNNEL_FRAME_BYTES = 64 * 1024;
const TUNNEL_FRAME_B64 = Math.ceil(TUNNEL_FRAME_BYTES / 3) * 4;

const Base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const rawBytes = (b64: string): number =>
  (b64.length / 4) * 3 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

/**
 * Both directions of a tunnel connection after its hello. `tunnel_data` carries 1 to 64 KiB; `tunnel_ack` the cumulative
 * bytes the other side has taken (never more than it was sent: the receiver closes the tunnel on such an ack); `tunnel_end`
 * says that side will send no more (a half-close). The gateway's transport frames (`ping`, `pong`) are not tunnel frames:
 * every reader answers a `ping` with a `pong` before it parses a `TunnelFrame` (the gateway closes a connection after three
 * unanswered pings, 45 s). Any other shape closes the tunnel.
 */
export const TunnelFrame = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("tunnel_data"),
      data: z
        .string()
        .min(4)
        .max(TUNNEL_FRAME_B64)
        .regex(Base64)
        .refine((b64) => rawBytes(b64) <= TUNNEL_FRAME_BYTES, "at most 64 KiB raw"),
    })
    .strict(),
  z
    .object({ type: z.literal("tunnel_ack"), bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) })
    .strict(),
  z.object({ type: z.literal("tunnel_end") }).strict(),
]);
export type TunnelFrame = z.infer<typeof TunnelFrame>;

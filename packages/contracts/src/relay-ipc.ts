import { z } from "zod";
import { VM_IPV4 } from "./agents-net.ts";
import { LaunchId, RelayKey } from "./agents-vm.ts";
import { ClaudeToken } from "./agents-vm-methods.ts";
import { BoxRef } from "./box-ref.ts";

const Provider = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const ModelIdText = z.string().min(1).max(256);
/** R13: what the daemon tells its relay child over IPC. Never logged (grants and the Claude token are secrets). */
export const RelayCommand = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("relay_grant"),
      launchId: LaunchId,
      box: BoxRef,
      key: RelayKey,
      /** A VM on the bridge, or loopback for the process backend (tests). */
      address: z.union([z.string().regex(VM_IPV4), z.literal("127.0.0.1")]),
    })
    .strict(),
  z.object({ type: z.literal("relay_revoke"), launchId: LaunchId }).strict(),
  z
    .object({
      type: z.literal("box_policy"),
      box: BoxRef,
      /** The models the box's picker offers (ADR 0068), at most 512 pairs; the bridge's models make `claude` true. */
      models: z.array(z.object({ provider: Provider, id: ModelIdText }).strict()).max(512),
      claude: z.boolean(),
      /**
       * The `claude setup-token` value of the box's owner (M14), or null: the bridge of a box is served with its owner's token and
       * nobody else's. It is per box and replaced or cleared with the box's policy; the relay keeps no other token and no user.
       */
      claudeToken: ClaudeToken.nullable(),
      blocked: z.enum(["paused", "budget"]).nullable(),
    })
    .strict(),
]);
export type RelayCommand = z.infer<typeof RelayCommand>;
/** The most agents one `relay_usage` report holds: the relay splits a longer list over several reports. */
export const RELAY_USAGE_MAX_BOXES = 64;
/** What the relay child reports: its port once listening, and counts per box every 60 s (attribution, RT-17). */
export const RelayReport = z.discriminatedUnion("type", [
  z.object({ type: z.literal("relay_ready"), port: z.number().int().min(1).max(65_535) }).strict(),
  z
    .object({
      type: z.literal("relay_usage"),
      boxes: z
        .array(
          z
            .object({
              box: BoxRef,
              requests: z.number().int().min(0),
              refused: z.number().int().min(0),
              bytesIn: z.number().int().min(0),
              bytesOut: z.number().int().min(0),
            })
            .strict(),
        )
        .max(RELAY_USAGE_MAX_BOXES),
    })
    .strict(),
]);

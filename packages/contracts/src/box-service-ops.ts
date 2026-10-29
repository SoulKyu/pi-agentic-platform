import { z } from "zod";
import { SERVICE_LIMITS, ServiceCommand, ServiceName, ServicePort, ServiceView } from "./preview-service.ts";

/** `name` is the op's discriminator, so a service's name travels as `service` here (like `displayName` in `github.identity`). */
const op = <N extends string, S extends z.ZodRawShape>(name: N, shape: S) =>
  z.object({ name: z.literal(name), ...shape }).strict();

/** Preview services of a box (UX-2 §4): the daemon asks the guest, which supervises them. */
export const BOX_SERVICE_OPS = [
  op("svc.start", { service: ServiceName, command: ServiceCommand, port: ServicePort, network: z.boolean() }),
  op("svc.restart", { service: ServiceName }),
  op("svc.stop", { service: ServiceName }),
  op("svc.list", {}),
  op("svc.logs", { service: ServiceName }),
] as const;

export const BOX_SERVICE_RESULTS = {
  "svc.start": ServiceView,
  "svc.restart": ServiceView,
  "svc.stop": z.object({ stopped: z.boolean() }).strict(),
  "svc.list": z.object({ services: z.array(ServiceView).max(SERVICE_LIMITS.perBox) }).strict(),
  "svc.logs": z
    .object({ lines: z.array(z.string().max(SERVICE_LIMITS.lineChars)).max(SERVICE_LIMITS.logLines) })
    .strict(),
} as const;

/** Start and restart wait for readiness (30 s) and a stop (2 s grace): 45 s. */
export const BOX_SERVICE_TIMEOUTS = {
  "svc.start": 45_000,
  "svc.restart": 45_000,
  "svc.stop": 30_000,
  "svc.list": 30_000,
  "svc.logs": 30_000,
} as const;

import { z } from "zod";

/** UX-2 §4: what a box may run as a preview service. The guest, the daemon and the web read the same bounds. */
export const SERVICE_LIMITS = Object.freeze({
  perBox: 4,
  logLines: 200,
  lineChars: 512,
  readyMs: 30_000,
  commandChars: 4096,
  stopGraceMs: 2_000,
});
export const ServiceName = z.string().regex(/^[a-z0-9-]{1,32}$/);
export const ServicePort = z
  .number()
  .int()
  .min(1024)
  .max(65_535)
  .refine((port) => port < 7841 || port > 7843, "a bridge port");
export const ServiceId = z.string().regex(/^[0-9a-f]{32}$/);
/** Visible text; tab and new line stay (the platform ops' `Text` rule). */
export const ServiceCommand = z
  .string()
  .min(1)
  .max(4096)
  .refine((text) => !/(?![\t\n])\p{Cc}|[\p{Cf}\p{Zl}\p{Zp}]/u.test(text), "visible text");
export const ServiceState = z.enum(["running", "failed", "exited", "stopped"]);
export const ServiceFailure = z.enum(["port_timeout", "port_not_owned", "exited", "spawn_failed"]);
export const ServiceView = z
  .object({
    id: ServiceId,
    name: ServiceName,
    port: ServicePort,
    state: ServiceState,
    reason: ServiceFailure.nullable(),
    startedAt: z.number().int().nonnegative(),
    network: z.boolean(),
  })
  .strict();
export type ServiceView = z.infer<typeof ServiceView>;
/** The `preview` of `.pi/project.yaml`. */
export const PreviewDecl = z.object({ command: ServiceCommand, port: ServicePort }).strict();
export type PreviewDecl = z.infer<typeof PreviewDecl>;

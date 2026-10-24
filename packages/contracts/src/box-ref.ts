import { z } from "zod";
import { AgentId } from "./platform.ts";

/** Shared by the box stack (pap-vmd, the guest) and the product (projects, files, vcs): decision 124. Lowercase uuids only (`randomUUID`): one project, one spelling. */
export const ProjectId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export type ProjectId = z.infer<typeof ProjectId>;

export const BoxRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), id: AgentId }),
  z.object({ kind: z.literal("project"), id: ProjectId }),
]);
export type BoxRef = z.infer<typeof BoxRef>;

/** `agent:<id>` or `project:<uuid>`: the guest's `PAP_BOX`. */
export function boxKey(box: BoxRef): string {
  return `${box.kind}:${box.id}`;
}

export function parseBoxKey(text: string): BoxRef | null {
  const colon = text.indexOf(":");
  if (colon < 0) return null;
  const parsed = BoxRef.safeParse({ kind: text.slice(0, colon), id: text.slice(colon + 1) });
  return parsed.success ? parsed.data : null;
}

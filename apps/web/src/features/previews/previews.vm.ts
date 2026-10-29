import { boxKey, parseBoxKey, ServiceName, type BoxRef } from "@pap/contracts";

/** The shell's preview item, structurally: features never import the workspace (`ItemRef` accepts it). */
export interface PreviewTarget {
  readonly kind: "preview";
  readonly box: string;
  readonly name: string;
}

export const targetOf = (box: BoxRef, name: string): PreviewTarget => ({
  kind: "preview",
  box: boxKey(box),
  name,
});

/** pap's own window for a preview (UX2-R79): the framed page full-window under its UNTRUSTED label. Never the capability URL. */
export const windowPath = (box: BoxRef, name: string): string => `/preview/${boxKey(box)}/${name}`;

/** The box and service a `/preview/<box>/<name>` path names (the inverse of `windowPath`), or null for any other path. */
export function parseWindowPath(pathname: string): { readonly box: BoxRef; readonly name: string } | null {
  const parts = pathname.split("/");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "preview") return null;
  const box = parseBoxKey(parts[2] ?? "");
  const name = ServiceName.safeParse(parts[3]);
  return box === null || !name.success ? null : { box, name: name.data };
}

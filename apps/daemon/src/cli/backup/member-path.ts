export class UnsafeArchiveError extends Error {
  override name = "UnsafeArchiveError";
}

const MAX_PATH = 1024;

/**
 * A member name that stays inside the folder it is extracted to: relative, no `..`, no empty or `.` part, no NUL, no control,
 * format or line-separator character, and no U+FFFD (what Node shows for bytes that are not UTF-8: tar would write the raw bytes).
 */
export function safeMemberPath(name: string): string {
  const path = name.endsWith("/") ? name.slice(0, -1) : name;
  if (
    path === "" ||
    path.length > MAX_PATH ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}�]/u.test(path)
  )
    throw new UnsafeArchiveError("the archive holds a path that is not safe");
  return path;
}

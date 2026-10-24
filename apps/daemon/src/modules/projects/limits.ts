/** Projects per owner (M4R22). */
export const MAX_PROJECTS = 2000;

// A path to compare lexically: absolute, no NUL, no empty, `.` or `..` segment, no trailing slash.
export const isCleanPath = (path: string): boolean =>
  path.startsWith("/") &&
  !path.includes("\0") &&
  (path === "/" ||
    path
      .slice(1)
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".."));

/** `URL.canParse` without it: Safari before 17 lacks it, and the build floor is 16.4. */
export function parseUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

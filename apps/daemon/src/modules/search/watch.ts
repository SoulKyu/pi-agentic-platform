import { watch } from "node:fs";

/** A folder watcher: null when it could not be set up (the caller relies on the reconcile then). */
export type WatchFactory = (
  dir: string,
  onEvent: (name: string | null) => void,
  onError: (code: string) => void,
) => (() => void) | null;

const codeOf = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : "unknown";
};

/** `fs.watch` without keeping the process alive (M4R70). */
export const fsWatch: WatchFactory = (dir, onEvent, onError) => {
  try {
    const watcher = watch(dir, { persistent: false }, (_type, name) =>
      onEvent(typeof name === "string" ? name : null),
    );
    watcher.on("error", (error) => {
      watcher.close();
      onError(codeOf(error));
    });
    return () => watcher.close();
  } catch (error) {
    onError(codeOf(error));
    return null;
  }
};

import { useCallback, useState } from "react";

/** What a tab holds beyond its file: the edit in progress, and the version of the file it started from. */
export interface Buffer {
  readonly baseEtag: string | null;
  readonly baseText: string;
  readonly draft: string;
}

export type ViewMode = "preview" | "source";

export interface Buffers {
  readonly byPath: ReadonlyMap<string, Buffer>;
  /** The paths with unsaved edits. */
  readonly dirty: ReadonlySet<string>;
  readonly modes: ReadonlyMap<string, ViewMode>;
  /** Sets the draft of `path`, starting from `base` when the tab had no edit yet; a draft equal to its base is no edit. */
  edit(path: string, base: { readonly etag: string | null; readonly text: string }, draft: string): void;
  /** The edit is saved or thrown away. */
  drop(path: string): void;
  setMode(path: string, mode: ViewMode): void;
  /** Forgets everything about the paths that are not in `tabs`: the buffers live as long as their tab (at most MAX_TABS). */
  retain(tabs: readonly string[]): void;
}

/** The unsaved buffers and Preview / Source choices of the open tabs, kept above the viewer: a viewer is remounted on every tab switch. */
export function useBuffers(): Buffers {
  const [byPath, setByPath] = useState<ReadonlyMap<string, Buffer>>(new Map());
  const [modes, setModes] = useState<ReadonlyMap<string, ViewMode>>(new Map());

  const edit = useCallback<Buffers["edit"]>((path, base, draft) => {
    setByPath((current) => {
      const next = new Map(current);
      const known = current.get(path);
      const from = known ?? { baseEtag: base.etag, baseText: base.text };
      if (draft === from.baseText) next.delete(path);
      else next.set(path, { baseEtag: from.baseEtag, baseText: from.baseText, draft });
      return next;
    });
  }, []);
  const drop = useCallback((path: string) => {
    setByPath((current) => {
      if (!current.has(path)) return current;
      const next = new Map(current);
      next.delete(path);
      return next;
    });
  }, []);
  const setMode = useCallback((path: string, mode: ViewMode) => {
    setModes((current) => new Map(current).set(path, mode));
  }, []);
  const retain = useCallback((tabs: readonly string[]) => {
    const keep = new Set(tabs);
    const only = <V>(current: ReadonlyMap<string, V>): ReadonlyMap<string, V> =>
      [...current.keys()].every((path) => keep.has(path))
        ? current
        : new Map([...current].filter(([path]) => keep.has(path)));
    setByPath(only);
    setModes(only);
  }, []);

  return { byPath, dirty: new Set(byPath.keys()), modes, edit, drop, setMode, retain };
}

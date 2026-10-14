import { IMAGE_MIMES, FILE_LIMITS, type AttachmentView } from "@pap/contracts";
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { useT } from "../../../i18n/index.ts";
import { windowTimers } from "../../../runtime/index.ts";
import type { Timers } from "../../../runtime/connection.ts";
import { uploadAttachment, UploadError } from "../../../runtime/upload.ts";
import { codeText } from "../failure.ts";
import { acceptsDrag, displayName, filesOf, pastedFiles } from "./drop.ts";
import "./register-files-catalog.ts";

/** The daemon refuses a fifth upload in flight for one owner (M8R106): the tray never sends more. */
const MAX_IN_FLIGHT = 4;
const CAPACITY_RETRIES = 5;
const CAPACITY_RETRY_MS = 2000;
const DRAG_FADE_MS = 300;

export interface AttachmentItem {
  readonly key: string;
  readonly name: string;
  readonly size: number;
  /** `queued`: waiting for a free slot (this tray's four, or the daemon's). */
  readonly status: "queued" | "uploading" | "ready" | "failed";
  readonly id: string | null;
  readonly kind: "image" | "file" | null;
  /** A local object URL of a picture: never a server fetch. */
  readonly previewUrl: string | null;
  /** A picture the daemon classed as a file. */
  readonly asFile: boolean;
  readonly error: string | null;
}

export interface Attachments {
  readonly items: readonly AttachmentItem[];
  readonly note: string | null;
  readonly uploading: boolean;
  readonly ready: number;
  /** Chips whose upload failed: the message cannot go while one is in the tray. */
  readonly failed: number;
  readonly hasImage: boolean;
  readonly dragging: boolean;
  /** The ready attachments' ids, in the order they were added. */
  ids(): string[];
  add(files: readonly File[], folders: number): void;
  remove(key: string): void;
  /** Takes the ready attachments with these ids out of the tray: what a message carried, and nothing else. */
  drop(ids: readonly string[]): void;
  /** Uploads the ready attachments with these ids again, for fresh ids (the first send may have delivered the old ones). */
  renew(ids: readonly string[]): void;
  retry(key: string): void;
  clear(): void;
  onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void;
  onDrop(event: DragEvent<HTMLTextAreaElement>): void;
  onDragOver(event: DragEvent<HTMLTextAreaElement>): void;
}

export interface AttachmentDeps {
  upload?(sessionId: string, file: File, signal: AbortSignal): Promise<AttachmentView>;
  timers?: Timers;
}

interface Entry {
  readonly file: File;
  controller: AbortController | null;
  attempts: number;
}

const IMAGES: readonly string[] = IMAGE_MIMES;

/**
 * The files of one message (M8R85): each uploads at once, at most four at a time, to the daemon's pending store; the
 * message then carries the ids. Nothing is kept across a reload. A removed or abandoned upload is aborted; a pending
 * copy the daemon already holds expires there.
 */
export function useAttachments(sessionId: string, deps: AttachmentDeps = {}): Attachments {
  const t = useT();
  const upload = deps.upload ?? uploadAttachment;
  const timers = deps.timers ?? windowTimers;
  const [items, setItems] = useState<readonly AttachmentItem[]>([]);
  const [noteKind, setNoteKind] = useState<"tooMany" | "folders" | null>(null);
  const [dragging, setDragging] = useState(false);
  const itemsRef = useRef<readonly AttachmentItem[]>([]);
  const entries = useRef(new Map<string, Entry>());
  const counter = useRef(0);
  const fade = useRef<number | null>(null);
  const retryTimer = useRef<number | null>(null);
  const pumpRef = useRef<() => void>(() => {});

  const update = useCallback((next: readonly AttachmentItem[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);
  const patch = useCallback(
    (key: string, change: Partial<AttachmentItem>) => {
      update(itemsRef.current.map((item) => (item.key === key ? { ...item, ...change } : item)));
    },
    [update],
  );

  const start = (key: string) => {
    const entry = entries.current.get(key);
    if (!entry) return;
    const controller = new AbortController();
    entry.controller = controller;
    patch(key, { status: "uploading", error: null });
    upload(sessionId, entry.file, controller.signal).then(
      (view) => {
        if (controller.signal.aborted) return;
        patch(key, {
          status: "ready",
          id: view.id,
          kind: view.kind,
          name: view.name,
          asFile:
            view.kind === "file" && itemsRef.current.some((i) => i.key === key && i.previewUrl !== null),
        });
        pumpRef.current();
      },
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        const code = failure instanceof UploadError ? failure.code : "internal";
        if (code === "capacity" && entry.attempts++ < CAPACITY_RETRIES) {
          patch(key, { status: "queued" });
          // Nothing of this tray is running to wait for: the daemon is busy with something else.
          if (!itemsRef.current.some((i) => i.status === "uploading") && retryTimer.current === null) {
            retryTimer.current = timers.set(() => {
              retryTimer.current = null;
              pumpRef.current();
            }, CAPACITY_RETRY_MS);
          }
          return;
        }
        patch(key, { status: "failed", error: code });
        pumpRef.current();
      },
    );
  };
  // Starts queued items while fewer than four run; called when an upload settles and by the capacity timer.
  const pump = () => {
    let running = itemsRef.current.filter((item) => item.status === "uploading").length;
    for (const item of itemsRef.current) {
      if (running >= MAX_IN_FLIGHT) break;
      if (item.status === "queued") {
        running++;
        start(item.key);
      }
    }
  };
  useEffect(() => {
    pumpRef.current = pump;
  });

  const release = (item: AttachmentItem) => {
    entries.current.get(item.key)?.controller?.abort();
    entries.current.delete(item.key);
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  };
  const clear = useCallback(() => {
    for (const item of itemsRef.current) {
      entries.current.get(item.key)?.controller?.abort();
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    entries.current.clear();
    if (retryTimer.current !== null) timers.clear(retryTimer.current);
    retryTimer.current = null;
    setNoteKind(null);
    update([]);
  }, [timers, update]);
  // A screen that goes away (sign-out included) leaves no upload running and no object URL alive.
  useEffect(
    () => () => {
      clear();
      if (fade.current !== null) timers.clear(fade.current);
    },
    [clear, timers, sessionId],
  );

  // A file dropped beside the field must not make the browser open it and leave the page.
  useEffect(() => {
    const keep = (event: Event) => {
      const types = (event as globalThis.DragEvent).dataTransfer?.types;
      if (types && Array.from(types).includes("Files")) event.preventDefault();
    };
    document.addEventListener("dragover", keep);
    document.addEventListener("drop", keep);
    return () => {
      document.removeEventListener("dragover", keep);
      document.removeEventListener("drop", keep);
    };
  }, []);

  const add = (files: readonly File[], folders: number) => {
    let note: "tooMany" | "folders" | null = folders > 0 ? "folders" : null;
    const added: AttachmentItem[] = [];
    for (const file of files) {
      if (itemsRef.current.length + added.length >= FILE_LIMITS.attachmentsPerPrompt) {
        note = "tooMany";
        break;
      }
      const key = `a${++counter.current}`;
      entries.current.set(key, { file, controller: null, attempts: 0 });
      added.push({
        key,
        name: file.name,
        size: file.size,
        status: "queued",
        id: null,
        kind: null,
        previewUrl: IMAGES.includes(file.type) ? URL.createObjectURL(file) : null,
        asFile: false,
        error: null,
      });
    }
    setNoteKind(note);
    if (added.length === 0) return;
    update([...itemsRef.current, ...added]);
    pumpRef.current();
  };
  const startOne = (key: string) => {
    patch(key, { status: "queued", error: null });
    pumpRef.current();
  };

  const text = (item: AttachmentItem): AttachmentItem => ({
    ...item,
    name: displayName(item.name),
    error:
      item.error === null
        ? null
        : item.error === "interrupted"
          ? t("sessions.files.interrupted")
          : item.error === "payload_too_large"
            ? t("sessions.files.tooLarge")
            : item.error === "limit_reached"
              ? t("sessions.files.limitReached")
              : codeText(item.error),
  });

  return {
    items: items.map(text),
    note:
      noteKind === "tooMany"
        ? t("sessions.files.tooMany", { count: FILE_LIMITS.attachmentsPerPrompt })
        : noteKind === "folders"
          ? t("sessions.files.folders")
          : null,
    uploading: items.some((item) => item.status === "uploading" || item.status === "queued"),
    ready: items.filter((item) => item.status === "ready").length,
    failed: items.filter((item) => item.status === "failed").length,
    hasImage: items.some((item) => item.status === "ready" && item.kind === "image"),
    dragging,
    ids: () => itemsRef.current.flatMap((item) => (item.status === "ready" && item.id ? [item.id] : [])),
    add,
    clear,
    remove: (key) => {
      const item = itemsRef.current.find((candidate) => candidate.key === key);
      if (!item) return;
      release(item);
      setNoteKind(null);
      update(itemsRef.current.filter((candidate) => candidate.key !== key));
      pumpRef.current();
    },
    drop: (ids) => {
      const gone = itemsRef.current.filter((item) => item.id !== null && ids.includes(item.id));
      for (const item of gone) release(item);
      update(itemsRef.current.filter((item) => !gone.includes(item)));
    },
    renew: (ids) => {
      update(
        itemsRef.current.map((item) =>
          item.id !== null && ids.includes(item.id)
            ? { ...item, status: "queued", id: null, kind: null, error: null }
            : item,
        ),
      );
      pumpRef.current();
    },
    retry: (key) => {
      const entry = entries.current.get(key);
      if (entry) entry.attempts = 0;
      startOne(key);
    },
    onPaste: (event) => {
      const files = pastedFiles(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      add(files, 0);
    },
    onDragOver: (event) => {
      if (!acceptsDrag(event.dataTransfer)) return;
      event.preventDefault();
      // An explorer row is not a file to attach: it can be dropped, but the hint would lie.
      if (Array.from(event.dataTransfer.types).includes("Files")) setDragging(true);
      if (fade.current !== null) timers.clear(fade.current);
      fade.current = timers.set(() => {
        fade.current = null;
        setDragging(false);
      }, DRAG_FADE_MS);
    },
    onDrop: (event) => {
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      setDragging(false);
      const { files, folders } = filesOf(event.dataTransfer);
      add(files, folders);
    },
  };
}

import type { MarkdownProps, PathLinks, RichReplies, ShellHandOff } from "@pap/ui";
import { useMemo } from "react";
import "../../i18n/register-reply-tools.ts";
import "../../i18n/register-rich-replies.ts";
import { useT, type Translate } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { useReplyPorts, type ReplyPort } from "../../stores/reply-ports.ts";
import { IDLE, useShellAnswers } from "../../stores/shell-answers.ts";
import { resolveImage } from "./image-target.ts";
import { findPaths } from "./path-links.ts";
import { artifactOf } from "./rich-artifacts.ts";
import { shellText } from "./shell-text.ts";

const markdownFailed = () => reportClientIssue("lazy_chunk_failed");

function pathLinksOf(port: ReplyPort, t: Translate): PathLinks {
  return {
    find: (text, whole) => findPaths(text, port.scope, whole),
    open: (span) => port.openFile(span.path, span.line),
    label: (span) => t("reply.path.open", { path: span.text }),
  };
}

function richRepliesOf(port: ReplyPort | undefined, t: Translate): RichReplies {
  return {
    onLoadError: markdownFailed,
    ...(port ? { image: (src: string, signal?: AbortSignal) => resolveImage(src, port.scope, signal) } : {}),
    ...(port ? { openFile: (path: string) => port.openFile(path, null) } : {}),
    labels: {
      image: (alt) => t("reply.rich.image", { alt }),
      openFile: (path) => t("reply.rich.openFile", { path }),
      preview: t("reply.rich.preview"),
      hide: t("reply.rich.hide"),
      artifactFrame: t("reply.rich.artifactFrame"),
      artifactTitle: t("reply.rich.artifactTitle"),
      mermaidError: t("reply.rich.mermaidError"),
      mermaidTooLarge: t("reply.rich.mermaidTooLarge"),
      diagram: t("reply.rich.diagram"),
    },
  };
}

const OUTCOME_COPY = {
  typed: "reply.shell.typed",
  multiline: "reply.shell.multiline",
  timeout: "reply.shell.timeout",
  unavailable: "reply.shell.unavailable",
  too_long: "reply.shell.tooLong",
  busy: "reply.shell.busy",
} as const;

function shellHandOffOf(
  sessionId: string,
  toTerminal: NonNullable<ReplyPort["toTerminal"]>,
  t: Translate,
): ShellHandOff {
  const keyOf = (code: string, lang: string) => `${sessionId}\u0000${lang}\u0000${code}`;
  return {
    label: t("reply.shell.toTerminal"),
    // A block with nothing left to type has no button; a too long one keeps it, to say why.
    canSend(code, lang) {
      const typed = shellText(code, lang);
      return !("refused" in typed) || typed.refused !== "empty";
    },
    subscribe: (onChange) => useShellAnswers.subscribe(onChange),
    statusOf: (code, lang) => useShellAnswers.getState().byBlock[keyOf(code, lang)] ?? IDLE,
    async send(code, lang) {
      const key = keyOf(code, lang);
      const { set, byBlock } = useShellAnswers.getState();
      if (byBlock[key]?.since != null) return; // the click that is running answers
      set(key, { since: performance.now(), answer: null });
      const typed = shellText(code, lang);
      const outcome =
        "refused" in typed
          ? typed.refused === "too_long"
            ? "too_long"
            : "unavailable"
          : await toTerminal(typed.text);
      useShellAnswers
        .getState()
        .set(key, { since: null, answer: { ok: outcome === "typed", text: t(OUTCOME_COPY[outcome]) } });
    },
  };
}

/**
 * What a reply's Markdown needs from its session (UX-1): the copy labels, the load error, and the path links of the
 * session's reply port. One object per port and language, so a streaming block's memo holds. A finished message passes its
 * entry id and text: its html fences get PREVIEW.
 */
export function useReplyMarkdown(
  sessionId: string,
  finished: boolean,
  entryId?: string | null,
  text?: string,
): Pick<MarkdownProps, "onLoadError" | "copyLabels" | "pathLinks" | "shellHandOff" | "richReplies"> {
  const t = useT();
  const port = useReplyPorts((state) => state.ports[sessionId]);
  // Its own memo: finishing a reply (the shell hand-off appears) must not hand every image a new lookup function.
  const base = useMemo(() => richRepliesOf(port, t), [port, t]);
  // PREVIEW for html fences exists only for a finished message with an entry id (the daemon reads the fence from it, UX2-R50).
  const richReplies = useMemo(
    () =>
      finished && entryId != null && text !== undefined
        ? { ...base, ...artifactOf(sessionId, entryId, text, t) }
        : base,
    [base, finished, entryId, text, sessionId, t],
  );
  return useMemo(
    () => ({
      onLoadError: markdownFailed,
      copyLabels: { copy: t("sessions.code.copy"), copied: t("sessions.code.copied") },
      richReplies,
      ...(port ? { pathLinks: pathLinksOf(port, t) } : {}),
      ...(finished && port?.toTerminal
        ? { shellHandOff: shellHandOffOf(sessionId, port.toTerminal, t) }
        : {}),
    }),
    [sessionId, port, t, finished, richReplies],
  );
}

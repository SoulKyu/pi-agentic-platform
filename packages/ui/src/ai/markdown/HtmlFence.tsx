import { useContext, useState } from "react";
import { Button } from "../../primitives/Button.tsx";
import { InlineError } from "../../primitives/InlineError.tsx";
import { ARTIFACT_SANDBOX, SandboxedFrame } from "../SandboxedFrame.tsx";
import { CodeBlock, type CodeCopyLabels } from "./CodeBlock.tsx";
import { RichRepliesContext } from "./rich-replies.ts";

type Preview =
  | { readonly state: "off" }
  | { readonly state: "minting" }
  | { readonly state: "open"; readonly url: string }
  | { readonly state: "failed"; readonly message: string };

/**
 * An `html` fence: its code, as always, and, when the app can mint an artifact for it, PREVIEW under it. The page is never
 * written into pap's DOM: PREVIEW asks the daemon for a URL of the untrusted origin (the daemon read the fence itself,
 * UX2-R50) and frames it with `allow-scripts` only, under the UNTRUSTED label drawn outside the frame. `offset`: where the
 * fence starts in the message text; null (a fence that is not top-level) gets no PREVIEW.
 */
export function HtmlFence({
  code,
  lang,
  labels,
  offset,
}: {
  readonly code: string;
  readonly lang: string;
  readonly labels?: CodeCopyLabels;
  readonly offset: number | null;
}) {
  const rich = useContext(RichRepliesContext);
  const [preview, setPreview] = useState<Preview>({ state: "off" });
  const mint = rich?.artifact;
  const canPreview = mint !== undefined && offset !== null && rich?.canArtifact?.(offset, code) === true;
  const open = preview.state === "minting" || preview.state === "open";
  const toggle = () => {
    if (mint === undefined || offset === null) return;
    if (open) return setPreview({ state: "off" });
    const pending: Preview = { state: "minting" };
    setPreview(pending);
    mint(offset, code).then(
      (url) => setPreview((now) => (now === pending ? { state: "open", url } : now)),
      (failure: unknown) =>
        setPreview((now) =>
          now === pending
            ? { state: "failed", message: failure instanceof Error ? failure.message : String(failure) }
            : now,
        ),
    );
  };
  return (
    <div className="flex min-w-0 flex-col gap-s1">
      <CodeBlock code={code} lang={lang} labels={labels} />
      {canPreview && rich ? (
        <div>
          <Button variant="ghost" size="sm" onClick={toggle}>
            {open ? rich.labels.hide : rich.labels.preview}
          </Button>
        </div>
      ) : null}
      {preview.state === "open" && rich ? (
        <div className="flex h-artifact max-h-artifact flex-col">
          <SandboxedFrame
            src={preview.url}
            sandbox={ARTIFACT_SANDBOX}
            label={rich.labels.artifactFrame}
            title={rich.labels.artifactTitle}
            className="max-h-artifact"
          />
        </div>
      ) : null}
      {preview.state === "failed" ? <InlineError announce="action">{preview.message}</InlineError> : null}
    </div>
  );
}

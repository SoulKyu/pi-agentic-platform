import "./register-lane-new-catalog.ts";
import type { LanePreview, ScriptKind } from "@pap/contracts";
import { Heading, useIsPhone } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { escapeHidden } from "../../lib/escape-hidden.ts";

type Script = LanePreview["config"]["scripts"][number];

const KIND_KEYS = {
  setup: "laneNew.script.setup",
  archive: "laneNew.script.archive",
  test: "laneNew.script.test",
} as const satisfies Record<ScriptKind, string>;

const CODE = "max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-code text-fg";

// The owner approves what he reads, so bidi and zero-width characters are written out; lines and tabs stay as they are.
const visible = (text: string): string =>
  text
    .split(/([\n\t])/)
    .map((part) => (part === "\n" || part === "\t" ? part : escapeHidden(part)))
    .join("");

/** "301 lines · 307 characters": a script padded with blank lines cannot pass for a short one behind the scrollbar. */
function Size({ text }: { readonly text: string }) {
  const t = useT();
  const lines = text.split("\n").length;
  const chars = [...text].length;
  const lineWords = t(lines === 1 ? "laneNew.script.size.lines.one" : "laneNew.script.size.lines.other", {
    count: lines,
  });
  const charWords = t(chars === 1 ? "laneNew.script.size.chars.one" : "laneNew.script.size.chars.other", {
    count: chars,
  });
  return (
    <span data-slot="script-size" className="font-mono text-code tabular-nums text-muted">
      {t("laneNew.script.size", { lines: lineWords, chars: charWords })}
    </span>
  );
}

/**
 * A script the owner has not approved (decision 30, DESIGN §2's dashed attention frame): new, or changed since the
 * last approval, with both texts side by side as plain text, and what it reaches.
 */
export function ScriptTrust({ script }: { readonly script: Script }) {
  const t = useT();
  const phone = useIsPhone();
  const kind = t(KIND_KEYS[script.kind]);
  return (
    <section
      data-slot="script-trust"
      className="flex flex-col gap-s2 rounded-md border border-dashed border-attn p-s2"
    >
      <Heading level={3} variant="group" tone="attn">
        {t(script.previous === null ? "laneNew.script.new" : "laneNew.script.changed", { kind })}
      </Heading>
      {script.previous === null ? (
        <>
          <Size text={script.text} />
          <pre className={CODE}>{visible(script.text)}</pre>
        </>
      ) : (
        <div className={phone ? "grid grid-cols-1 gap-s2" : "grid grid-cols-2 gap-s2"}>
          <div className="flex min-w-0 flex-col gap-s1">
            <span className="label-hud text-muted">{t("laneNew.script.before")}</span>
            <Size text={script.previous} />
            <pre className={CODE}>{visible(script.previous)}</pre>
          </div>
          <div className="flex min-w-0 flex-col gap-s1">
            <span className="label-hud text-muted">{t("laneNew.script.now")}</span>
            <Size text={script.text} />
            <pre className={CODE}>{visible(script.text)}</pre>
          </div>
        </div>
      )}
      <p className="text-ui text-muted">{t("laneNew.script.reach")}</p>
    </section>
  );
}

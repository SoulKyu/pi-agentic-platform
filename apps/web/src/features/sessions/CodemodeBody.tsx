import { Fence, type ToolDetail } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import type { NestedCallView } from "../../stores/nested-calls.ts";
import { durationText, sectionsOf } from "./codemode.vm.ts";
import type { FencePart } from "./fence.vm.ts";

const BLOCK = "whitespace-pre-wrap break-words font-mono text-code";
const GLYPH = { ok: "✓", error: "✗", cancelled: "⊘" } as const;
const GLYPH_TONE = { ok: "text-ok", error: "text-err", cancelled: "text-muted" } as const;

function CallRow({ call }: { call: NestedCallView }) {
  const t = useT();
  const label = t(`sessions.codemode.status.${call.status}`);
  return (
    <li data-slot="codemode-call" className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-baseline gap-s2 font-mono text-code">
        <span role="img" aria-label={label} className={`shrink-0 ${GLYPH_TONE[call.status]}`}>
          {GLYPH[call.status]}
        </span>
        <span className="shrink-0 text-fg">{call.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted">{call.args}</span>
        {call.durationMs === null ? null : (
          <span className="shrink-0 text-label tabular-nums text-muted">{durationText(call.durationMs)}</span>
        )}
      </div>
      {call.error === null ? null : <p className="break-words pl-s4 text-ui text-err">{call.error}</p>}
    </li>
  );
}

/** The expanded dedicated card: the script, the calls it made, its output. Every string is text, never markup. */
export function CodemodeBody({
  code,
  calls,
  parts,
  failed,
  detail,
}: {
  code: string;
  calls: readonly NestedCallView[] | undefined;
  /** The output without its header, split on pap's fences. */
  parts: readonly FencePart[];
  failed: boolean;
  detail: ToolDetail;
}) {
  const t = useT();
  const bound = detail === "full" ? "" : "max-h-64 overflow-auto";
  const label = "label-hud text-muted";
  return (
    <div className="flex flex-col gap-s2">
      <section className="flex flex-col gap-s1">
        <h4 className={label}>{t("sessions.codemode.script")}</h4>
        <pre data-slot="codemode-script" className={`${BLOCK} ${bound} text-fg`}>
          {code}
        </pre>
      </section>
      {calls && calls.length > 0 ? (
        <section className="flex flex-col gap-s1">
          <h4 className={label}>{t("sessions.codemode.callsTitle")}</h4>
          <ul className="flex flex-col gap-s1">
            {calls.map((call, index) => (
              <CallRow key={index} call={call} />
            ))}
          </ul>
        </section>
      ) : null}
      {parts.length > 0 ? (
        <section className="flex flex-col gap-s1">
          <h4 className={label}>{t("sessions.codemode.output")}</h4>
          {parts.map((part, index) =>
            part.kind === "fenced" ? (
              <Fence key={index} label={t("sessionPolicy.fence", { source: part.source })}>
                {sectionsOf(part.text).join("\n\n")}
              </Fence>
            ) : (
              sectionsOf(part.text).map((section, at) => (
                <pre
                  key={`${index}:${at}`}
                  data-slot="codemode-output"
                  className={`${BLOCK} ${bound} ${failed ? "text-err" : "text-fg"}`}
                >
                  {section}
                </pre>
              ))
            ),
          )}
        </section>
      ) : null}
    </div>
  );
}

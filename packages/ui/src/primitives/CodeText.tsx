/** Backticked runs become code; nothing else is parsed, so markup in `text` stays text. An unclosed backtick stays plain. */
export function CodeText({ text }: { readonly text: string }) {
  const parts = text.split(/(`[^`]+`)/);
  return (
    <>
      {parts.map((part, index) =>
        part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
          <code key={index} data-slot="code-text" className="font-mono text-code">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

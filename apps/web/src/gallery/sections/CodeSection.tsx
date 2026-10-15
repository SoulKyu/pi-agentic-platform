import { CodeEditor, DiffView, languageFor, ReviewDiffView } from "@pap/ui/code";
import { useT } from "../../i18n/index.ts";
import { CODE } from "../fixtures.ts";
import { GalleryItem, GallerySection } from "../GalleryItem.tsx";

const LANGUAGE = languageFor(CODE.path);
const LABELS = { label: CODE.label, noChanges: CODE.noChanges };

/** The CodeMirror editor and the diff views, themed by the frame's tokens. */
export function CodeSection() {
  const t = useT();
  return (
    <GallerySection id="code" title={t("gallery.section.code")}>
      <GalleryItem name="CodeEditor" column>
        <div className="h-48 w-full">
          <CodeEditor value={CODE.after} language={LANGUAGE} labels={LABELS} />
        </div>
      </GalleryItem>
      <GalleryItem name="DiffView" column>
        <div className="h-48 w-full overflow-auto">
          <DiffView before={CODE.before} after={CODE.after} language={LANGUAGE} labels={LABELS} />
        </div>
      </GalleryItem>
      <GalleryItem name="ReviewDiffView" column>
        <div className="h-48 w-full overflow-auto">
          <ReviewDiffView
            before={CODE.before}
            after={CODE.after}
            language={LANGUAGE}
            labels={LABELS}
            comments={[]}
            onComment={() => {}}
            onOpenComment={() => {}}
          />
        </div>
      </GalleryItem>
    </GallerySection>
  );
}

import { Checkbox, Collapsible, Segmented, Select, Slider, Switch, TextField } from "@pap/ui";
import { useState } from "react";
import { SAMPLE, SEGMENT_OPTIONS, SELECT_OPTIONS } from "../fixtures.ts";
import { GalleryItem } from "../GalleryItem.tsx";

type Model = (typeof SELECT_OPTIONS)[number]["value"];
type View = (typeof SEGMENT_OPTIONS)[number]["value"];

const LONG_OPTIONS = Array.from({ length: 300 }, (_, index) => ({
  value: `model-${String(index + 1)}`,
  label: `Model ${String(index + 1)}`,
}));

/** The controlled form primitives, each with local state so the gallery responds to the pointer and the keyboard. */
export function FormFigures() {
  const [path, setPath] = useState<string>(SAMPLE.fieldValue);
  const [notes, setNotes] = useState("");
  const [model, setModel] = useState<Model>("sonnet");
  const [notify, setNotify] = useState(true);
  const [remember, setRemember] = useState(false);
  const [size, setSize] = useState(14);
  const [longChoice, setLongChoice] = useState("model-1");
  const [view, setView] = useState<View>("chat");
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <GalleryItem name="TextField" column>
        <TextField label={SAMPLE.field} value={path} onChange={setPath} hint={SAMPLE.fieldHint} />
        <TextField label={SAMPLE.field} value="" onChange={setPath} error={SAMPLE.fieldError} />
        <TextField label={SAMPLE.notes} value={notes} onChange={setNotes} multiline />
      </GalleryItem>
      <GalleryItem name="Select" column>
        <Select<Model> label={SAMPLE.select} value={model} options={SELECT_OPTIONS} onChange={setModel} />
      </GalleryItem>
      <GalleryItem name="Select, 300 options" column>
        <div data-testid="gallery-select-long">
          <Select label={SAMPLE.select} value={longChoice} options={LONG_OPTIONS} onChange={setLongChoice} />
        </div>
      </GalleryItem>
      <GalleryItem name="Switch" column>
        <Switch label={SAMPLE.switchLabel} hint={SAMPLE.switchHint} checked={notify} onChange={setNotify} />
        <Switch label={SAMPLE.switchLabel} checked={false} onChange={setNotify} disabled />
      </GalleryItem>
      <GalleryItem name="Checkbox" column>
        <Checkbox label={SAMPLE.checkbox} checked={remember} onChange={setRemember} />
        <Checkbox label={SAMPLE.checkbox} checked onChange={setRemember} disabled />
      </GalleryItem>
      <GalleryItem name="Slider" column>
        <Slider
          label={SAMPLE.slider}
          value={size}
          min={12}
          max={18}
          onChange={setSize}
          valueText={(value) => `${value} px`}
        />
      </GalleryItem>
      <GalleryItem name="Segmented">
        <Segmented<View> label={SAMPLE.segmented} value={view} options={SEGMENT_OPTIONS} onChange={setView} />
      </GalleryItem>
      <GalleryItem name="Collapsible" column>
        <Collapsible open={expanded} onOpenChange={setExpanded} trigger={<span>{SAMPLE.collapsible}</span>}>
          <p className="text-ui text-muted">{SAMPLE.collapsibleBody}</p>
        </Collapsible>
      </GalleryItem>
    </>
  );
}

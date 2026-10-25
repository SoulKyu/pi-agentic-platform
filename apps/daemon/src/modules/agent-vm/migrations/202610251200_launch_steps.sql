-- How long each step of a box's launches took, to say "usually 8 s" in the launch panel. Only steps that ended well count (a skipped
-- image or a failed step is no sample); the writer keeps the last 20 rows per box and step, in the insert's transaction.
CREATE TABLE launch_steps (
  box_key TEXT NOT NULL,
  step TEXT NOT NULL,
  ms INTEGER NOT NULL CHECK (ms >= 0),
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX launch_steps_recent ON launch_steps(box_key, step, at);

-- Always-on boxes (decision 149): a box project the owner asked never to stop on its own. Old rows read as off.
ALTER TABLE project_boxes ADD COLUMN always_on INTEGER NOT NULL DEFAULT 0;

-- An automation run's closed tool list and its unattended flag (M10, ADR 0041). NULL / 0 for every other session.
-- `tool_allowlist`: a JSON array of tool names; the worker blocks any other tool by name at stage 02, nested codemode
-- calls included, until the owner chooses "Use my normal tools" once the task ended (owner m10a7).
-- `unattended`: the task is not finished. Unknown tools and unreadable commands then block (owner m10a2), and the
-- session cannot be switched to full-access.
ALTER TABLE session_policy ADD COLUMN tool_allowlist TEXT
  CHECK (tool_allowlist IS NULL OR (json_valid(tool_allowlist) AND json_type(tool_allowlist) = 'array'
    AND length(tool_allowlist) <= 4096));
ALTER TABLE session_policy ADD COLUMN unattended INTEGER NOT NULL DEFAULT 0
  CHECK (unattended IN (0, 1) AND (unattended = 0 OR tool_allowlist IS NOT NULL));

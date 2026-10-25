-- Which providers the owner shares with members' boxes. A row is written the first time a provider is seen (never derived on
-- each read), so a provider that moves from a subscription to an API key does not become shared on its own.
CREATE TABLE provider_sharing (
  provider TEXT PRIMARY KEY,
  shared INTEGER NOT NULL CHECK (shared IN (0, 1))
) STRICT;

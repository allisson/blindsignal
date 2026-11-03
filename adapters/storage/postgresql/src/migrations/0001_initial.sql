-- The registry (ADR 0005): the whole record as JSON, keyed for the two reads (ADR 0019).
CREATE TABLE applications (
  app_id text PRIMARY KEY,
  issuer text NOT NULL UNIQUE,
  record jsonb NOT NULL
);

-- One per (app_id, sub, device_id) (ADR 0010); expired rows are deleted (ADR 0012).
CREATE TABLE devices (
  app_id text NOT NULL,
  user_id text NOT NULL,
  device_id text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_authenticated_at timestamptz NOT NULL,
  PRIMARY KEY (app_id, user_id, device_id)
);

CREATE INDEX devices_last_authenticated_at ON devices (last_authenticated_at);

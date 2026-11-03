-- Row-level security with no policy: every role but the tables' owner, which the server and the
-- migration command use, reads and writes nothing, so a provider's API over the schema, such as
-- Supabase's, never reaches the registry or the devices (ADR 0027).
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;

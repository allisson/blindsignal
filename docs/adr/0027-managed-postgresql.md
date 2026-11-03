# Managed PostgreSQL behind a pooler

**Status:** accepted

Spec §10.1 allows Supabase as a managed PostgreSQL provider, with no business logic depending on
its APIs. The server already uses only `pg` (ADR 0019), so evaluating Supabase meant checking what
a managed provider puts between the server and the database: a transaction-mode pooler, an HTTP
API over the schema, and its own certificate authority. Two of them broke assumptions:

- **The migration lock did not hold behind a transaction-mode pooler.** The runner took a
  session-scoped advisory lock and released it at the end, but the pooler hands each statement
  outside a transaction to whichever server connection is free. Through PgBouncer, two clients got
  the same lock on one shared server connection, concurrent runs collided on `CREATE TABLE`, and a
  failed run left the lock held by an idle server connection, blocking every later migration.
- **A provider's API could reach the tables.** Supabase's Data API serves the `public` schema
  with the browser-visible `anon` key, and on projects with its default grants that role may read
  and write new tables. A row written into `applications` with an attacker's public key would be
  installed by every instance at its next sync (ADR 0024), letting the attacker mint accepted
  tokens.

## Rules

- **Each migration runs in its own transaction, under a transaction-scoped advisory lock,** key
  `(0x42534947, 0)`, and checks `schema_migrations` under that lock before applying. A pooler keeps
  a transaction on one server connection, so the migration command runs through any pooler mode,
  or directly, and concurrent runs still apply each migration once.
- **Migration `0002` enables row-level security on every table, with no policy.** Every role
  but the tables' owner, superusers, and roles with `BYPASSRLS` reads and writes nothing, whatever
  it was granted. The server and the migration command connect as the owner, as before. This is
  plain PostgreSQL; on a database without such an API it changes nothing.
- **The server's queries stay pooler-safe:** unnamed statements, no session state, no
  `LISTEN`/`NOTIFY`, and transaction-scoped locks only (ADR 0020, ADR 0025).
- **CI runs the PostgreSQL adapter's tests twice,** directly and through PgBouncer in transaction
  mode with prepared statements off (`compose.yaml`), the stand-in for a provider's pooler.
- **`docs/supabase.md`** documents which connection to use, TLS with the provider's certificate
  authority, pool sizing, and turning off the Data API's exposure of new tables.

## Considered options

- **Documenting that migrations need a direct or session-mode connection.** Rejected: a
  deployment with one URL would migrate through the pooler, and the failure, a lock held forever,
  shows up only when two runs overlap.
- **Only documenting the Data API settings.** Rejected: the registry's integrity would depend on
  every operator finding and following that step.
- **Moving the tables to a schema of their own,** outside the API's exposed schemas. Rejected:
  existing deployments would move tables and set `search_path` in their URL, and it protects only
  while that schema stays unexposed.
- **Supabase's own pooler image (Supavisor) in CI.** Rejected: it needs a metadata database and a
  tenant setup; PgBouncer's transaction mode imposes the same constraints on the client.

## Consequences

- The server and the migration command must connect as the role that owns the tables, or one
  with `BYPASSRLS`; a server connecting as a less privileged role sees an empty registry and
  cannot enroll devices.
- Each release still runs the migration command first (ADR 0019); `0002` is required by this
  release, so the server refuses to start until it is applied.
- What was checked: the pooler behavior, through PgBouncer 1.26 in transaction mode, and the
  row-level security, with a role granted every privilege. What was not: a live Supabase project,
  so its certificate chain and Supavisor's handling of these queries remain to be confirmed by the
  first deployment, following `docs/supabase.md`.

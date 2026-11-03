# Persistence and coordination dependencies

**Status:** accepted

Phase 9 adds the adapters of spec §10 for multi-instance deployments: `PostgreSQLStorageAdapter`
in `adapters/storage/postgresql` and a Redis-compatible `CoordinationAdapter` in
`adapters/coordination/redis` (spec §19). ADR 0001 allows no tool outside it without an ADR, and
these adapters need a PostgreSQL driver, a migration mechanism, a Redis client, and services to
test against. Each dependency stays inside its adapter package (ADR 0002): business logic and the
in-memory adapters never see it, and `pnpm test` still needs no external service (spec §4.6).

## Rules

- **PostgreSQL driver: `pg` (node-postgres), with hand-written SQL.** Its queries use unnamed
  statements by default, so it works behind a transaction-mode pooler, such as Supabase's, with
  no extra setting. Types come from `@types/pg`. Every query is parameterized; no SQL is built by
  concatenating values.
- **Migrations: numbered SQL files in the PostgreSQL adapter, applied by a runner of its own.**
  The runner records each applied file in a `schema_migrations` table, applies each file in its
  own transaction, and holds a PostgreSQL advisory lock while it runs, so two instances never
  migrate together. ADR 0027 takes that lock in each file's transaction, so it holds behind a
  pooler. Migrations run through a separate command, before a release starts, never on
  server startup. At startup the server checks the schema version and refuses to start when the
  database is behind the version it needs; a newer schema is accepted, so each migration keeps the
  previous release working (expand, then contract).
- **Coordination: the `redis` client (node-redis), tested against Valkey.** The spec asks for
  Redis-compatible coordination; Valkey is the BSD-licensed fork, and the adapter uses only
  commands both implement. Each `CoordinationAdapter` operation that ADR 0010 makes atomic is one
  Lua script or one `MULTI`, never several round trips that another instance can interleave.
- **Test services, as for TURN (ADR 0017):** PostgreSQL and Valkey in `compose.yaml`, under a
  profile, bound to loopback, with credentials that, like the development issuer's key, are public
  and never trusted in production. The adapters' integration tests run only when
  `BLINDSIGNAL_TEST_POSTGRES_URL` or `BLINDSIGNAL_TEST_REDIS_URL` is set, and CI runs them in a job
  that starts the compose services. A contract suite for each interface runs against the in-memory
  adapter on every `pnpm test` and against the real adapter in that job, so both keep the same
  behavior.
- **Versions are pinned when each adapter lands,** after checking that the client is maintained
  and that the images are current, as ADR 0001 pins the toolchain.

## Considered options

- **`postgres` (postgres.js).** Rejected: its prepared statements need `prepare: false` behind a
  transaction-mode pooler, and its tagged-template API offers nothing three repositories need.
- **A query builder or ORM (Kysely, Drizzle).** Rejected: a layer over a handful of queries, and
  the atomic device touch of ADR 0010 is clearer as one SQL statement.
- **`node-pg-migrate`.** Rejected: a dependency for what a short runner does, with rollbacks the
  expand-then-contract rule does not use.
- **An external migration tool (dbmate, goose).** Rejected: a binary outside the ADR 0001
  toolchain, to install in every environment.
- **Migrating on server startup.** Rejected: every instance of a rolling deploy would race for the
  lock, and a failed migration would surface as instances that never become ready.
- **`ioredis` or its fork `iovalkey`.** Rejected: equivalent APIs, with no reason to prefer them
  over the client the Redis project maintains.
- **Testing against Redis instead of Valkey.** Rejected for CI: the commands used are common to
  both, and Valkey's license carries no conditions for hosting it. A deployment may run either.
- **Testcontainers.** Rejected: another dependency, and Docker on every `pnpm test`.
- **GitHub Actions `services:` in CI and Compose locally.** Rejected: two definitions of the same
  services, which drift.

## Consequences

- A deployment with PostgreSQL runs the migration command before each release, and a migration
  that breaks the previous release is a bug.
- The contract suites become the definition of each interface's behavior; a behavior added to one
  adapter is added to the suite.
- Single-instance deployments keep the in-memory adapters and need neither service.

# PostgreSQL storage schema

**Status:** accepted

ADR 0019 chose `pg` and numbered SQL migrations for `adapters/storage/postgresql`. This ADR fixes
how that adapter keeps the two repositories of ADR 0010, so several server instances share them.
The adapter follows the current contract exactly; who is the source of truth, the registry file
or the database, is decided when the server is wired to it.

## Rules

- **`applications`:** one row per application, with `app_id` as the primary key, a unique
  `issuer`, and the whole `ApplicationRecord` as `jsonb`; dates are stored as ISO strings and read
  back as `Date`s. The registry parser validates every field, so the database never queries inside
  the record, and a field added to the registry needs no migration. `replaceAll` deletes every row
  and inserts the new registry in one transaction: a reader sees the previous registry until it
  commits, never a partial one.
- **`devices`:** one row per `(app_id, user_id, device_id)`, the primary key, with
  `first_seen_at` and `last_authenticated_at`. The time comes from the caller, as in the in-memory
  adapter, never from the database clock. A record is live while `last_authenticated_at` is less
  than one TTL old.
- **`touch` takes a lock only for a new device.** A live device is renewed with one `UPDATE`.
  Otherwise a transaction takes a transaction-scoped advisory lock for the application, deletes its
  expired records, renews the device if a concurrent call enrolled it meanwhile, counts the rest,
  and inserts the device when the quota allows. New devices of one application, on any instance,
  take turns, so concurrent first authentications never exceed the quota.
- **`deleteExpired(now, ttlMs)`, a new `DeviceRepository` method,** deletes every expired record
  and returns how many. Durable adapters delete expired device records on a schedule (ADR 0012);
  the server calls it, so the schedule is the server's configuration, not each adapter's timer.
  The in-memory adapter implements it too.
- **Advisory locks** use the key `(0x42534947, n)`: `n = 0` for migrations, `hashtext(app_id)` for
  device enrollment. A hash collision between two applications only makes them take turns.
- **Testing:** one contract suite in `@blindsignal/core/testing` runs against the in-memory
  adapter on every `pnpm test` and against PostgreSQL when `BLINDSIGNAL_TEST_POSTGRES_URL` is set,
  each test in a schema of its own; tests of the PostgreSQL adapter alone cover concurrency and the
  migration runner.

## Considered options

- **A column per field, and a table of revoked devices.** Rejected: constraints the registry parser
  already enforces, at the cost of a migration for every registry field.
- **`SERIALIZABLE` transactions with retries** for `touch`. Rejected: a retry loop and
  serialization errors to handle, for what one lock per application serializes.
- **`SELECT ... FOR UPDATE` on the application's row.** Rejected: `replaceAll` deletes and inserts
  that row, and a device would depend on its application being stored.
- **A timer inside the adapter** for expired records. Rejected: hidden scheduling, run once per
  instance.

## Consequences

- Every authentication reads `applications` and writes `devices`, one or two round trips; a cache
  in front of `applications` is decided with the server wiring, if measurements ask for it.
- Concurrent first authentications of one application wait for each other; renewals never do.

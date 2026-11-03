# Durable registry and storage failures

**Status:** accepted

ADR 0020 gave the server PostgreSQL storage. This ADR decides how the server uses it: what stays
the source of truth for the registry, how a storage failure reaches a client, and how expired
device records are deleted.

## Rules

- **Storage is chosen by `BLINDSIGNAL_DATABASE_URL`.** Unset, the server keeps the in-memory
  adapters, for a single instance. Set to a `postgres://` URL, it opens a pool of
  `BLINDSIGNAL_DATABASE_POOL_SIZE` connections (default 10, the driver's), refuses to start when
  the schema is behind this release's migrations (ADR 0019), and logs `storage.ready` with the
  storage it uses. Errors of idle connections are logged as `storage.connection_lost` instead of
  ending the process.
- **The registry file stays the source of truth; the database keeps the last registry accepted.**
  At startup and on every `SIGHUP` the server checks the file against the stored registry, which
  an earlier process or another instance wrote, together with every application this process saw
  revoked, and stores the result before installing it. So `createdAt` and `updatedAt` survive
  restarts, and revocation is terminal across restarts and instances: an instance whose file
  reactivates an application stored as revoked does not start, and its reload is rejected. A
  revoked application removed from the file is remembered only by the process that saw it, as
  before (ADR 0005).
- **Token verification reads a copy in the process,** installed with the registry, never the
  database: the authentication path makes no query for its application, and an instance answers
  with the registry it enforces. Connections on other instances learn of a reload when those
  instances sync from storage (ADR 0024).
- **A storage failure closes the connection with `server_error`.** A task of a connection that
  rejects, such as a device touch while the database is unreachable, sends `server_error`, a new
  retryable code, and closes with `4001`; the SDK reconnects with backoff. The log line
  `connection.failed` carries the error's SQLSTATE or name, never its message, which may quote
  values. A reload that cannot read or write storage is rejected and keeps the current registry.
- **Every instance deletes expired device records** every `BLINDSIGNAL_DEVICE_SWEEP_INTERVAL_SECONDS`
  (default 3600) through `DeviceRepository.deleteExpired` (ADR 0012, ADR 0020). The deletion is
  idempotent; a failure logs `devices.sweep_failed`, and the next sweep tries again.

## Considered options

- **The database as the source of truth,** with the file imported by a command. Rejected for now:
  it changes the control plane of ADR 0005 and needs reloads propagated between instances, which
  do not exist yet.
- **Devices only in the database,** the registry only in memory. Rejected: revocation would stay
  terminal only within one process, and the stored registry would have no use.
- **Token verification reading the database.** Rejected: a query on every authentication, and an
  instance would accept tokens against a registry another instance wrote while enforcing its own.
- **Closing with `1011` and no message** on a storage failure. Rejected: the client would not know
  why, and a new retryable code costs nothing to SDKs that already retry on `4001`.
- **`/readyz` querying the database.** Rejected: an outage would take every instance out of the
  load balancer at once, which is no better than answering `server_error`.
- **One instance sweeping, elected by an advisory lock.** Rejected: code for a deletion that is
  already idempotent.

## Consequences

- With the database down, new authentications get `server_error`; connections already
  authenticated keep working until their next `auth.refresh`, and reloads are rejected.
- A rolling deployment whose instances read different registry files stores whichever loaded
  last; revocations still hold, since an instance that would undo one does not start.

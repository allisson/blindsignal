# Backup and recovery

**Status:** accepted

Phase 10 asks for backup and recovery of durable metadata. With PostgreSQL storage the server keeps
two tables (ADR 0020): `applications`, the last registry accepted, and `devices`, one record per
enrolled device. Redis keeps only coordination state (ADR 0022). This ADR decides what an operator
must back up, how, and what a restore brings back.

## What each copy holds

- **The registry file is the source of truth** (ADR 0005, ADR 0021). Every start stores it in the
  database, so a deployment that keeps the file can rebuild `applications` from an empty database.
  It is the one copy an operator cannot lose.
- **`applications` adds three things to the file:** the `createdAt` and `updatedAt` of each
  application, and the guard that rejects a file reactivating an application stored as revoked
  (ADR 0021). An application removed from the file is removed from the table at the next load, so
  the table never remembers more than the file it last accepted.
- **`devices` rebuilds itself.** A device missing from the table enrolls again at its next
  authentication, counted against the quota like a new one; records expire after
  `BLINDSIGNAL_DEVICE_TTL_DAYS` anyway (ADR 0012). Losing the table resets each device's
  `firstSeenAt` and lets devices that never return stop counting at once.
- **Redis holds nothing to back up.** Presence, sessions, rate-limit windows, and connection slots
  are rebuilt as clients reconnect (ADR 0023); its persistence settings are the operator's choice.
  Amended by the Phase 12 security review: it also holds the `jti` claims, so data it loses while
  the instances run lets a used token authenticate again until it expires. Redis runs with
  `maxmemory-policy noeviction`, and every instance restarts after Redis loses data, since an
  instance rejects tokens issued before it started (ADR 0006).

## Rules

- **Back up the registry file and the environment** (the server's `.env` or the platform's secret
  store) together with every change, off the host: in a private repository or the operator's
  configuration management. Keep a revoked application in the file, with `"status": "revoked"`,
  for good; the file, not the database, is what keeps it revoked after a removal or a restore.
- **Back up PostgreSQL with `pg_dump`,** in its custom format, at least daily, and keep the dumps
  off the host and readable by operators only: `devices` holds user and device identifiers. On a
  managed provider, its own backups count, and a `pg_dump` keeps a copy outside it.
- **Restore with `pg_restore --clean --if-exists --no-owner --single-transaction`,** with every
  server instance stopped, as the role the server connects as, so that role owns the tables
  (ADR 0027). Then the migration command applies whatever the dump predates (ADR 0019), and the
  server checks the file against the restored registry as at every start.
- **Any dump restores safely.** A restored registry older than the file is updated from it; one
  that lists an application as revoked keeps a file that reactivates it from starting, the guard
  of ADR 0021 working as intended. Restored device records past their lifetime are deleted by the
  next sweep.
- **With no dump, start on an empty database.** The migration command creates the schema, the
  server stores the file, and clients enroll their devices again; only the three things above are
  lost.

## Considered options

- **Point-in-time recovery with WAL archiving** as a requirement. Rejected: the data either
  rebuilds itself or comes from the file, so a day-old dump loses nothing a client notices.
  Managed providers that offer it need no change here.
- **A backup service in `examples/self-hosted/`.** Rejected: one `pg_dump` from the host's cron
  does the job without another image to pin and update (ADR 0033).
- **Keeping removed revoked applications in the database** as tombstones, so the database alone
  keeps revocation terminal. Rejected for now: it changes what `replaceWith` stores (ADR 0021),
  and keeping the entry in the file already does it.
- **Backing up Redis.** Rejected: restoring presence or rate-limit windows from the past would be
  wrong, not just stale.

## Consequences

- An operator who loses the registry file and the database alike loses the list of applications,
  and with it the record of which ones were revoked.
- `docs/backup-and-recovery.md` is the procedure; `examples/self-hosted/` needs no change.

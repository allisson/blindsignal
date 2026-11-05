# Backup and recovery

What to back up in a BlindSignal deployment, and how to restore it. The decisions are in
`docs/adr/0035-backup-and-recovery.md`. A deployment with in-memory storage, without
`BLINDSIGNAL_DATABASE_URL`, keeps nothing durable but its registry file and environment.

## What to back up

| Copy | Holds | If it is lost |
| --- | --- | --- |
| Registry file | Every application, its keys, and its status | Rebuild it from the applications' backend teams; revoked applications can be reactivated by mistake |
| Environment or secret store | `BLINDSIGNAL_*` settings and the secrets of `docs/secrets-and-keys.md` | Rotate every secret |
| PostgreSQL | The last registry accepted, with `createdAt` and `updatedAt`, and the device records | Start on an empty database: see [Without a backup](#without-a-backup) |
| Redis or Valkey | Coordination state, and the `jti` claims | Restart every server instance: until then, a used token can authenticate again (ADR 0035) |

- **Keep the registry file and the environment off the host,** with every change: in a private
  repository or your configuration management. Never commit the secrets themselves to it.
- **Keep revoked applications in the registry file,** with `"status": "revoked"`. The database
  forgets an application removed from the file at the next reload, and a restore brings back only
  what the dump holds; the entry in the file is what keeps the application revoked.
- **Treat dumps as personal data:** `devices` holds user and device identifiers. Write them
  readable by you only, keep them off the host, and delete old ones.

## Backing up PostgreSQL

Dump the database at least once a day, in `pg_dump`'s custom format. With `examples/self-hosted/`:

```sh
cd examples/self-hosted
(umask 077; docker compose exec -T postgres pg_dump -U blindsignal -d blindsignal --format=custom >"blindsignal-$(date +%F).dump")
```

`umask 077` makes the file readable by you only. The `pg_dump` inside the container matches the
server's major version. Run it from the host's cron, then copy the dump off the host.

On a managed database, such as Supabase (`docs/supabase.md`), the provider's backups come first;
check how long the plan keeps them. A `pg_dump` with the server's `BLINDSIGNAL_DATABASE_URL`, over
the direct connection, keeps a copy outside the provider. Its `pg_dump` must be of the server's
major version or newer.

## Restoring

Restore with every server instance stopped, as the role the server connects as, so that role owns
the restored tables (ADR 0027). With `examples/self-hosted/`, on the same host or a new one with
the registry file and `.env` in place:

```sh
cd examples/self-hosted
docker compose stop server
docker compose up -d --wait postgres
docker compose exec -T postgres pg_restore -U blindsignal -d blindsignal --no-owner --clean --if-exists --single-transaction <blindsignal-2026-11-03.dump
docker compose up -d --build --wait
```

`--clean --if-exists` replaces the tables of a database in use and works on an empty one;
`--single-transaction` leaves the database as it was if the restore fails. Then `migrate` applies
the migrations newer than the dump, and the server checks the registry file against the restored
registry.

### After the restore

- `docker compose logs migrate` shows `schema up to date`, or the versions it applied.
- `docker compose logs server` shows `storage.ready` and `server.listening`.
- If the server stops with `a revoked application cannot be reactivated`, the dump holds that
  application as revoked and the file does not. Set it back to `"status": "revoked"` in the file
  and start again: a revocation is terminal (`docs/application-lifecycle.md`).
- Device records the dump holds count toward the quotas again; those past
  `BLINDSIGNAL_DEVICE_TTL_DAYS` go at the next sweep.

## Without a backup

With the registry file and the environment, an empty database is enough: start the deployment as on
its first day. The migration creates the schema and the server stores the file. What is lost:

- Each application's `createdAt` and `updatedAt`, which restart at that moment.
- Each device's record: devices enroll again at their next authentication, counted against the
  quota as new ones.
- The guard against a file that reactivates a revoked application, for applications the file no
  longer lists as revoked.

Clients see one reconnection, as after any restart.

## Testing a restore

Restore the latest dump on a spare host from time to time, and run the checks of
[After the restore](#after-the-restore). A second copy of `examples/self-hosted/` cannot run beside
the first on one host: both claim the address range `172.30.0.0/24`. A backup never restored is not
known to work.

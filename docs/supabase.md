# Supabase as the PostgreSQL provider

BlindSignal can keep its device records and registry in a Supabase project's PostgreSQL
(spec §10.1). It uses the database only: no Supabase client, Auth, Realtime, Storage, or Data API.
Coordination still needs Redis or Valkey (ADR 0023); Supabase does not provide it. The decisions
behind this guide are in `docs/adr/0027-managed-postgresql.md`.

The pooler behavior and the row-level security below were tested against PostgreSQL and PgBouncer
in CI, not against a live Supabase project. Run the checklist at the end on the first deployment.

## Connections

Copy the connection strings from the project's Connect dialog. Supabase offers three:

| Connection | Port | Use it for |
| --- | --- | --- |
| Direct, `db.<project-ref>.supabase.co` | 5432 | The server and the migration command, where the network reaches IPv6 or the project has the IPv4 add-on. |
| Shared pooler, session mode, `<pooler-host>` | 5432 | The server and the migration command on an IPv4-only network. |
| Shared pooler, transaction mode, `<pooler-host>` | 6543 | Works too: the server and the migration command hold no session state (ADR 0027). Prefer the others for a long-running server. |

Through the shared pooler the user is `postgres.<project-ref>`; directly it is `postgres`.

- **One role for both.** The server and the migration command must connect as the role that owns
  the tables, `postgres` on Supabase. Row-level security hides every table from any other role.
- **Pool size.** Each instance opens up to `BLINDSIGNAL_DATABASE_POOL_SIZE` connections (default
  10), and the migration command one. Keep instances × pool size within the plan's limit for the
  connection you use, shown in the project's database settings.

## TLS

`pg` treats `sslmode=require` as `verify-full`: it checks the server's certificate against the
system's certificate authorities and the hostname. Supabase signs its certificates with a
certificate authority of its own, so give `pg` that certificate:

1. Download it from the project's database settings, under SSL Configuration (the file is named
   like `prod-ca-2021.crt`), and ship it with the deployment as a file, not as a secret: it is a
   public certificate.
2. Add `sslmode=verify-full&sslrootcert=<path to the certificate>` to `BLINDSIGNAL_DATABASE_URL`.
3. Turn on SSL enforcement in the same settings, so no client connects without TLS.

Never use `sslmode=no-verify`: the password would go to whoever answers the connection.

## The Data API

Supabase serves the `public` schema over HTTP with the `anon` key, which browsers carry. On projects
with Supabase's default grants, the tables BlindSignal creates there would be readable and
writable through it, and a forged row in `applications` would let anyone mint accepted tokens.
Migration `0002` enables row-level security with no policy on every table, which denies that
access. Also, in the project's Data API settings, either turn the Data API off, when nothing else
in the project uses it, or turn off the automatic exposure of new tables.

## Migrations

Run the migration command before each release, with the same URL as the server (ADR 0019):

```sh
BLINDSIGNAL_DATABASE_URL='postgres://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=/etc/blindsignal/prod-ca-2021.crt' \
  pnpm --filter @blindsignal/storage-postgresql migrate
```

Supabase recommends the direct connection for migrations; the command also works through either
pooler mode.

## First-deployment checklist

- [ ] The migration command prints `applied 1, 2`, or `schema up to date` on a migrated project.
- [ ] The server logs `storage.ready` with that URL, through the connection the deployment uses.
- [ ] A connection without `sslrootcert` fails, and one with it succeeds: the certificate chain is
      the one this guide describes.
- [ ] Row-level security is on, in the SQL editor:
      `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('applications', 'devices', 'schema_migrations')`
      returns `true` three times.
- [ ] The Data API returns no rows: `curl 'https://<project-ref>.supabase.co/rest/v1/applications' -H "apikey: <anon key>"`
      answers `[]` or an error, never a row.

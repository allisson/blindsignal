# Secrets and keys

What a BlindSignal deployment keeps secret, where it lives, and how to rotate each value with no
client-visible errors, or with the shortest window where that is not possible. The decisions are in
`docs/adr/0034-secrets-and-signing-keys.md`.

## Inventory

| Value | Held by | Where | Rotation |
| --- | --- | --- | --- |
| Application signing key | The application's backend | Its own key store; never in the registry, the SDK, or a client bundle | [Application keys](#application-keys) |
| `BLINDSIGNAL_TURN_SECRET` | Server and Coturn | Server environment; Coturn `static-auth-secret` | [TURN secret](#turn-secret) |
| PostgreSQL password | Server and migration | Inside `BLINDSIGNAL_DATABASE_URL` | [PostgreSQL password](#postgresql-password) |
| Redis or Valkey password | Server | Inside `BLINDSIGNAL_REDIS_URL` | [Redis password](#redis-password) |

The server holds no private key. The registry file holds public keys and JWKS URLs only; it is not
secret, but whoever can change it decides which issuers the server trusts, so only operators may
write it.

Set the three server secrets from the platform's secret store: Secret Manager exposed as
environment variables on Cloud Run, or the `chmod 600` `.env` of `docs/self-hosted.md`. Never commit
them, and never pass them on a command line, where the process list shows them. The server never
logs them, and a configuration error names the variable, never its value.

## Application keys

The application's backend team rotates its own key; the operator acts only for static keys.

- **JWKS (`jwksUri`):** publish the new public key next to the old one, wait at least 10 minutes,
  the server's cache lifetime, then sign with the new key. Remove the old key once the last token
  it signed has expired: the maximum token lifetime plus the clock skew, 11 minutes by default.
- **Static keys (`publicKeys`):** add the new key to the application's entry, with a new `kid`, and
  reload the registry ([Applying a registry change](application-lifecycle.md#applying-a-registry-change)).
  The backend switches signing, and after the same wait the operator removes the old key and
  reloads again.

## TURN secret

Coturn accepts several `static-auth-secret` lines at once, which gives the overlap:

1. Generate the new secret: `openssl rand -base64 48`.
2. Add it to Coturn as a second `static-auth-secret`, keeping the old one, and restart Coturn.
   The restart ends every allocation; clients recover through the SDK's ICE restart.
3. Set `BLINDSIGNAL_TURN_SECRET` to the new secret and restart or redeploy the signaling server.
   It mints new credentials with it from then on.
4. Wait `BLINDSIGNAL_TURN_CREDENTIAL_TTL_SECONDS` (default 900), so every credential minted with
   the old secret has expired.
5. Remove the old `static-auth-secret` from Coturn and restart it.

## PostgreSQL password

A PostgreSQL role has one password, so the old one stops working the moment it changes. Between the
change and the restart, connections the pool opens fail: authentications get `server_error`, and
the SDK reconnects with backoff. Keep that window short, and outside peak hours.

1. Change the role's password: `ALTER ROLE <role> PASSWORD '...'` as a superuser or the role
   itself, or in the provider's console on a managed database, such as Supabase.
2. Update `BLINDSIGNAL_DATABASE_URL` in the secret store, and restart or redeploy every instance and
   the migration job.

With `examples/self-hosted/`, `POSTGRES_PASSWORD` in `.env` sets the password only when the volume
is first created; editing `.env` alone makes the migration fail with
`password authentication failed`. Change the role first, reading the new password from standard
input so it reaches no command line:

```sh
cd examples/self-hosted
read -rs NEW_PASSWORD   # type or paste the new password
printf "ALTER ROLE blindsignal PASSWORD '%s';\n" "$NEW_PASSWORD" |
  docker compose exec -T postgres psql -q -U blindsignal -d blindsignal
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$NEW_PASSWORD/" .env
unset NEW_PASSWORD
docker compose up -d --wait
```

Use a password of letters and digits, such as `openssl rand -hex 32`, so it needs no escaping in
SQL, `sed`, or the URL.

## Redis password

A Redis or Valkey ACL user holds several passwords, so the rotation has no gap. For the `default`
user, through `valkey-cli` or `redis-cli` authenticated with the old password:

1. `ACL SETUSER default >NEW_PASSWORD` adds the new password.
2. Update `BLINDSIGNAL_REDIS_URL` in the secret store, and restart or redeploy every instance.
3. `ACL SETUSER default <OLD_PASSWORD` removes the old one.

If the password also comes
from the server's configuration file (`requirepass` or an ACL file), update it there too, or a
restart of Redis brings the old one back. On a managed Redis, follow the provider's rotation,
which works the same way when it offers two passwords.

## After a compromise

Removal comes first; the overlap of the procedures above is for planned rotations.

- **An application's private key:** the backend team removes the public key from its JWKS, or the
  operator from `publicKeys`, and the operator restarts every instance: a JWKS stays cached in each
  process for 10 minutes, and a reload does not refresh it. Tokens signed with the key then fail
  with `invalid_token`, and connections already opened with one close at its expiry, within the
  maximum token lifetime. To cut those connections at once, suspend the application, then
  reactivate it once the key is gone (`docs/application-lifecycle.md`).
- **The TURN secret:** replace it in Coturn and the server together, with no overlap, and restart
  both. Coturn's restart ends the allocations made with stolen credentials.
- **The PostgreSQL or Redis password:** rotate it as above, and for Redis remove the old password
  first. Then check the database for changes you did not make.

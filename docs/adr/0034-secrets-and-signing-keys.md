# Secrets and signing keys

**Status:** accepted

Phase 10 asks for secret and signing-key management to be defined. The decisions are spread
across earlier ADRs: applications sign tokens with their own keys (ADR 0006), the server mints
TURN credentials from a shared secret (ADR 0017), and it connects to PostgreSQL and Redis with
URLs that carry passwords (ADR 0021, ADR 0023). This ADR lists every secret in one place and
decides how each is held, rotated, and replaced after a compromise. `docs/secrets-and-keys.md` is
the procedure.

## Rules

- **The server holds no signing key.** Each application's backend keeps its private key; the
  registry holds only public keys or a JWKS URL (ADR 0005), so the registry file is configuration,
  not a secret, though its integrity decides whom the server trusts.
- **Three secrets reach the server:** `BLINDSIGNAL_TURN_SECRET`, and the passwords inside
  `BLINDSIGNAL_DATABASE_URL` and `BLINDSIGNAL_REDIS_URL`. They come from the environment only, set
  from the platform's secret store, such as Secret Manager on Cloud Run or a `0600` `.env` on one
  host (ADR 0032). They are never logged, and a configuration error names the variable, never its
  value.
- **Every rotation overlaps where the other side allows two valid values,** so no client sees an
  error:
  - **Application keys:** the new public key is published next to the old one, signing switches
    after the JWKS cache lifetime, and the old key goes once its last token has expired
    (`docs/token-issuance.md`).
  - **TURN secret:** Coturn accepts several `static-auth-secret` values at once. The new one is
    added to Coturn, then to the server, and the old one leaves Coturn once the credentials minted
    with it have expired.
  - **Redis password:** a Redis or Valkey ACL user holds several passwords. The new one is added,
    the servers restart with it, then the old one is removed.
  - **PostgreSQL password:** a role has one password, so the overlap is not possible. The password
    changes, then every instance restarts with it at once; connections the pool opens in between
    fail, and their clients get `server_error` and reconnect.
- **A compromise is answered by removal first, overlap second.** A leaked application key leaves
  the registry or the JWKS at once and the instances restart, since a JWKS stays cached in each
  process for 10 minutes; tokens it signed then fail, and connections opened with them close at
  their token's expiry. A leaked TURN secret is replaced in Coturn and the server together, and
  Coturn's restart ends the allocations made with it.

## Considered options

- **Several TURN secrets in the server,** to sign with the newest and accept the others. Rejected:
  the server only signs, so one secret suffices; Coturn is the side that verifies, and it already
  accepts several.
- **Reading secrets from files (`_FILE` variables).** Rejected again (ADR 0032): on one host whoever
  reads the environment file reads the secret files, and managed platforms inject secrets as
  environment variables.
- **Flushing the JWKS cache on `SIGHUP`.** Rejected for now: a restart already does it, and a
  compromised key is the only case that needs it.
- **A second PostgreSQL login role** to rotate without a gap. Rejected: the server must connect as
  the owner of the tables (ADR 0027), and only one role owns them.

## Consequences

- A PostgreSQL password change costs a short window of `server_error`; schedule it outside peak
  hours.
- A restart also rejects tokens issued before it (ADR 0006); clients ask for new ones when they
  reconnect.
- Adding or removing a Coturn secret restarts Coturn, which ends every allocation; clients recover
  through the SDK's ICE restart (ADR 0017).

# Control plane as a reloadable registry file

**Status:** accepted

Operators need to register, suspend, reactivate, and revoke applications and revoke devices
without code changes (spec §5.6). Until Phase 9 the server keeps state only in memory, so an
administrative API or a CLI talking to one would lose every registration on restart, and a
bootstrap file would be needed anyway. The control plane is therefore a declarative JSON registry
file that the server loads at startup and reloads on `SIGHUP`. It has no network surface, so an
application-issued access token can never reach it.

## Behavior

- **One file, path from the environment.** It lists every application with the §5.1 record
  (`app_id`, name, status, issuer, audience, JWKS URI or static public keys, allowed algorithms,
  quotas) and, per application, the revoked devices by `sub` and `device_id`. JSON validated with
  Zod, so no new parser enters the toolchain (ADR 0001). The development issuer is an ordinary
  entry with its static public key (ADR 0002); outside development mode, an entry with the dev
  issuer's origin or public key is rejected, since its private key is public in this repository.
- **File format.** Keys are camelCase, matching `ApplicationRecord` in `packages/core`; the
  §5.1 names (`app_id`, `jwks_uri`) are concepts, not keys. Unknown keys are rejected, so a
  misspelled key fails the load instead of being ignored. Static keys are public JWKs (`OKP`
  Ed25519 or `EC` P-256) with a unique `kid`; private key members are rejected. Quotas and rate
  limits an entry leaves out take the server defaults (ADR 0011). The operator writes no
  timestamps: the server sets `createdAt` when it first loads an application and `updatedAt` when
  a reload changes its entry, both in memory until Phase 9.

  ```json
  {
    "applications": [
      {
        "appId": "blindnotes",
        "name": "BlindNotes",
        "status": "active",
        "issuer": "https://api.blindnotes.example",
        "audience": "blindsignal",
        "jwksUri": "https://api.blindnotes.example/.well-known/jwks.json",
        "algorithms": ["EdDSA"],
        "quotas": { "devices": 1000 },
        "revokedDevices": [{ "userId": "user_123", "deviceId": "device_456" }]
      }
    ]
  }
  ```

- **Reload is all or nothing.** An unreadable or invalid file, or one that breaks a rule below,
  is rejected whole: the server keeps the previous registry and logs the reason without secrets.
- **Reload applies the difference immediately.** Suspending or revoking an application, removing
  it from the file, or revoking a device rejects new authentication and closes the affected
  connections (spec §5.5, §6.3).
- **Revocation is terminal within the process.** A reload that turns a revoked application back
  to `active` or `suspended`, or re-adds a removed one that was revoked, is rejected. Across
  restarts the file is the durable record: a revoked application stays in it as `revoked`.
- **Only `suspended` reactivates** to `active`.

## Considered options

- **Authenticated admin API**: rejected for the MVP. It adds an authenticated network surface and
  an operator credential, and with in-memory storage its writes do not survive a restart.
- **CLI**: needs either durable storage to write to or an admin API to call; neither exists
  before Phase 9.

## Consequences

- On hosts without signals (Cloud Run), a registry change is a new deployment, which restarts the
  instance and drops all connections; SDKs reconnect.
- Phase 9 revisits this with durable storage, where an admin API or CLI may replace the file
  through a new ADR.

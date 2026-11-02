# Namespace authorization from token claims

**Status:** accepted

The MVP needs a namespace authorization source that does not depend on pairing (spec §7.3). The
application backend already knows which workspaces, vaults, or conversations a user may reach,
so it asserts the device's namespaces in the `namespaces` claim of the token it issues (ADR 0006).
Policy stored by BlindSignal was rejected: it would make BlindSignal hold each application's
access rules and need a control plane for per-user grants, while the registry file (ADR 0005)
only manages applications and revoked devices.

## Rules

- **Namespace IDs are `<app_id>:<scope>`,** with a non-empty scope. A token whose `namespaces`
  claim holds an entry without its own application's prefix is rejected with `invalid_token`, so
  a backend cannot grant namespaces of another application.
- **A connection is authorized exactly in the namespaces of its current token.** No wildcards and
  no patterns: every entry is an exact ID. Everything else is denied, and an unauthorized
  namespace looks the same as a nonexistent one (`not_authorized`).
- **`auth.refresh` replaces the set.** For every namespace the new token no longer lists, the
  server removes the device from it (other devices see `presence.changed` with `present: false`)
  and ends the connection's sessions in it, sending both participants `session.terminated` with
  reason `namespace_unauthorized`. Newly listed namespaces become joinable; the server does not
  join them on the device's behalf.

## Consequences

- Revoking a user's access to a namespace takes effect at the user's next `auth.refresh` or
  reconnect, so within the maximum token lifetime. Faster removal needs device revocation
  (ADR 0005).
- The registry holds no namespace policy, and the MVP needs no namespace or authorization
  repository.
- The token grows with the number of namespaces; the configurable maximum length of the claim
  bounds it.

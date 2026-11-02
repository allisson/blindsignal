# Backend token issuance

What an application backend must do to issue access tokens BlindSignal accepts. The token profile
is in `docs/adr/0006-token-profile-and-device-identity.md` and spec §5.3; this document turns it
into requirements for the backend. Defaults below are the server's; the operator may change them.

## Flow

1. The browser calls an endpoint of the application backend, authenticated by the backend's own
   user session.
2. The backend decides whether the user may use BlindSignal, and in which namespaces.
3. The backend signs a short-lived token for that user and device with its private key, and
   returns it.
4. The SDK sends the token in `auth.authenticate` or `auth.refresh`, never in a URL.

The SDK's `accessTokenProvider` calls that endpoint for every connection and every refresh, since
each token is accepted once. The endpoint must mint a new token on every call; never cache one.

## Registration

The BlindSignal operator registers the application in the registry file
(`docs/adr/0005-control-plane.md`). The backend team provides:

| Field        | Value                                                                       |
| ------------ | --------------------------------------------------------------------------- |
| `appId`      | Lowercase letters, digits, `_` and `-`, 1–64 characters, starting with a letter or digit. |
| `issuer`     | The exact `iss` value of every token. One issuer per application.           |
| `audience`   | The exact `aud` value, usually `blindsignal`.                               |
| `jwksUri`    | An HTTPS URL serving the public keys as a JWK Set, or else:                 |
| `publicKeys` | The public JWKs, each with a unique `kid`.                                  |
| `algorithms` | `EdDSA`, `ES256`, or both.                                                  |

## Keys

- Sign with Ed25519 (`EdDSA`) or P-256 (`ES256`). Symmetric algorithms and RSA are rejected.
- The private key stays on the backend. It never reaches browser code, the SDK, or a client
  bundle (spec §5.2).
- Every key has a `kid`, and every token names it in its header.
- A JWKS endpoint answers within 5 seconds. The server caches the set for 10 minutes and, on an
  unknown `kid`, refetches at most once every 30 seconds per issuer.

## Token

Header: `{ "alg": "EdDSA" | "ES256", "kid": "<key id>" }`.

| Claim        | Requirement                                                                              |
| ------------ | ---------------------------------------------------------------------------------------- |
| `iss`        | The registered issuer.                                                                   |
| `aud`        | The registered audience.                                                                 |
| `sub`        | The user's stable ID in the application, 1–256 characters.                               |
| `app_id`     | The registered `appId`.                                                                  |
| `device_id`  | The device's stable ID for this user, 1–256 characters.                                  |
| `iat`        | The issuance time, in seconds.                                                           |
| `exp`        | `iat` plus the lifetime; at most `iat` + 600 seconds.                                    |
| `jti`        | A new random value for every token, such as a UUID.                                      |
| `namespaces` | An array, possibly empty, of at most 100 namespace IDs the device may join.             |
| `nbf`        | Optional. Omit it or set it to `iat`.                                                    |

Other claims are ignored. Example:

```json
{
  "iss": "https://api.blindnotes.example",
  "aud": "blindsignal",
  "sub": "user_123",
  "app_id": "blindnotes",
  "device_id": "device_456",
  "iat": 1793500000,
  "exp": 1793500300,
  "jti": "5f0c1c3e-7d64-4f43-9a51-1c0a7a3b9e21",
  "namespaces": ["blindnotes:workspace-789"]
}
```

### Lifetime and clocks

- Use 5 minutes. The SDK refreshes 60 seconds before expiry, so a lifetime under 2 minutes makes
  it refresh almost constantly.
- Keep the backend clock synchronized (NTP). The server tolerates 60 seconds of skew on `iat`,
  `nbf`, and `exp`; beyond it, a token from the future is rejected.
- After a server restart, tokens issued before the restart are rejected, since the server no
  longer knows which were used. Clients get a new token when they reconnect.

### Identity

- A device is `(app_id, sub, device_id)`. The backend chooses `device_id`; it must be stable for
  one device of one user, and is not a credential.
- `sub` and `device_id` must not carry secrets or personal data beyond an opaque ID: they appear
  in protocol messages to other devices.
- An `auth.refresh` token must keep the connection's `sub` and `device_id`.

### Namespaces

- Each entry is `<app_id>:<scope>`, with the application's own `app_id` and a scope of 1–128
  visible ASCII characters, no spaces. An entry for another application rejects the whole token.
- The list is exact: no wildcards. It authorizes the connection until the next refresh, which
  replaces it (`docs/adr/0007-namespace-authorization.md`). To revoke a namespace, leave it out of
  the next token; the change takes effect within one token lifetime.

## Token endpoint

- Require the user's authenticated session, and protect it from cross-site requests as any other
  state-changing endpoint.
- Rate-limit it per user: each call mints a credential.
- Never log tokens.

## Key rotation

- **JWKS:** publish the new key next to the old one, wait at least the 10-minute cache lifetime,
  then sign with the new key. Keep the old key published until the last token signed with it has
  expired, plus the skew.
- **Static keys:** ask the operator to add the new key and reload the registry, switch signing,
  then remove the old key after the same wait.

## Rejections

The client sees these codes on `auth.authenticate` (`docs/protocol.md` §9):

| Code                      | Backend-side cause                                                          |
| ------------------------- | --------------------------------------------------------------------------- |
| `invalid_token`           | Wrong key, `kid`, algorithm, issuer, audience, or `app_id`; a missing or malformed claim; a namespace of another application or too many; lifetime above the maximum; `iat` ahead of the server clock or before its start; a reused `jti`. |
| `token_expired`           | Expired on arrival: check the backend clock and that tokens are not cached. |
| `application_unavailable` | The application is suspended or revoked in the registry.                    |
| `device_revoked`          | The operator revoked this user's device.                                    |

The server never says which check failed, so an attacker learns nothing from the code. To debug,
compare the token against the tables above.

## Development

`packages/dev-issuer` mints tokens with a fixed test key for local development and tests. Its
private key is public in this repository: the server trusts it only when `BLINDSIGNAL_ENV` is
`development`, and refuses a registry that names it otherwise. Never use it for a real backend.

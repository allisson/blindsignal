# Backend issuer example

An application backend that issues BlindSignal access tokens with its own key, as
`docs/token-issuance.md` requires: the user signs in, enrolls each device's key, gets a token per
connection, and adds devices through pairing (ADR 0042). It uses `node:http`, `jose`, and `zod`,
and keeps everything in memory: a real backend keeps users, devices, and used pairing IDs in its
own database, and replaces `/login` with its own sign-in.

## Policy

- A user's first device gets the namespace `<appId>:<user>`.
- A later device gets a token with that namespace in `pairing` only, until one of the user's
  devices that holds it approves the new one.
- Every token is bound to the device's key with `cnf.jkt`, and lasts 5 minutes.

## Routes

Every `POST` needs `content-type: application/json` and an `Origin` among the allowed ones, so a
cross-site form cannot call it; every one but `/login` needs the session cookie. Errors are status
codes alone.

| Route                        | Body                                  | Answer                                                                                                     |
| ---------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `POST /login`                | `{ user }`                            | `204`, with an `HttpOnly; Secure; SameSite=Strict` session cookie. No password: it stands in for sign-in. |
| `POST /devices`              | `{ deviceId, jkt }`                   | `204`. The first `jkt` of a device stays; another one gets `409`.                                          |
| `POST /token`                | `{ deviceId }`                        | `200`, the token as text, `no-store`. An unknown device gets `404`.                                        |
| `POST /pairings`             | `{ deviceId, namespace, approval }`   | `204` once the approval passes the checks of `docs/token-issuance.md`, Pairing; else `403`.                |
| `GET /.well-known/jwks.json` | —                                     | The public key, for a registry entry with `jwksUri`.                                                       |

`deviceId` is the SDK's device ID, `jkt` is `deviceKey.thumbprint`, and `approval` the one an
`approved` result of `client.requestPairing()` carries (`packages/sdk/README.md`).

## Running

```sh
cd examples/backend-issuer

# A new signing key. Keep it out of the repository and out of browser code.
export BLINDSIGNAL_EXAMPLE_SIGNING_JWK="$(node src/keygen.ts)"

# A registry file trusting it, for the signaling server's BLINDSIGNAL_REGISTRY_PATH
node src/registry.ts > registry.json

# The backend, on http://127.0.0.1:4000
pnpm start
```

| Variable                             | Default                       | Meaning                                                  |
| ------------------------------------ | ----------------------------- | -------------------------------------------------------- |
| `BLINDSIGNAL_EXAMPLE_SIGNING_JWK`    | required                      | The private P-256 JWK with its `kid`, from `keygen`.     |
| `BLINDSIGNAL_EXAMPLE_APP_ID`         | `example`                     | The registered `appId`, and the namespaces' prefix.      |
| `BLINDSIGNAL_EXAMPLE_ISSUER`         | `http://127.0.0.1:<port>`     | The `iss` of every token, and the registered issuer.     |
| `BLINDSIGNAL_EXAMPLE_ALLOWED_ORIGINS` | `http://127.0.0.1:<port>`    | Comma-separated origins whose pages may call it.         |
| `BLINDSIGNAL_EXAMPLE_PORT`           | `4000`                        | The port it listens on, on loopback.                     |

The registry file lists the public key in `publicKeys`: the server fetches a JWKS only over
HTTPS. Behind HTTPS, register `jwksUri` with this backend's `/.well-known/jwks.json` instead, and
rotate keys as `docs/token-issuance.md` describes.

The cookie is `Secure`: browsers keep it on `http://127.0.0.1` and `http://localhost`, and need
HTTPS anywhere else.

## Tests

`pnpm test` runs `src/backend.test.ts` with the rest of the workspace: it verifies every token
against the published key, signs approvals with the SDK's `DeviceKey`, and refuses each failed
pairing check, a missing session, another origin, and a non-JSON request.

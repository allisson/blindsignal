# Integration feedback

What building the reference integrations of Phase 11 taught about integrating BlindSignal:
`examples/backend-issuer`, `examples/minimal-app`, `docs/tailscale.md`, two applications on one
server, and `docs/application-e2ee.md`. Each finding names where it showed up and where it stands;
an open one names the roadmap task it belongs to. The findings come from these examples only, not
from an outside application.

## Fixed

| Finding | Where it showed up | Fix |
|---|---|---|
| `pairing.request` lacked the new device's key thumbprint, which the approving device signs in the approval's `jkt` claim. The server's tests passed because they already knew the key. | Writing the SDK side of pairing | `jkt` in `pairing.request` (#97, ADR 0042) |
| The minimal app's sign-in form submitted natively, reloading the page, when clicked before its script finished loading. | Firefox's cold start in CI | The button stays disabled until the script is ready (#104) |
| The SDK had no public way to refresh the token on demand: after the backend granted a pairing, the minimal app closed the client and connected again to get a token with the namespace. | `examples/minimal-app/public/app.ts` | `client.refresh()` (ADR 0046) |

## Documented

| Finding | Where it is documented |
|---|---|
| A `jwksUri` must be HTTPS, so a backend on a development machine lists its keys in `publicKeys` instead. | `docs/token-issuance.md#registration`, `examples/backend-issuer/README.md` |
| `BLINDSIGNAL_ALLOWED_ORIGINS` is server-wide: adding an application with its own origin changes the server's environment, and the registry carries no origins. | `docs/application-lifecycle.md`, spec §16 |
| `DeviceKey` needs a secure context and the SDK refuses `ws://` except on loopback, so a device on the local network cannot use a plain `http://` address. | `docs/tailscale.md` |
| Every device on one development machine connects from `127.0.0.1` and shares its per-IP limits; a test with many devices gets `rate_limited`. | `apps/server/README.md`, `examples/minimal-app/playwright.config.ts`, `examples/browser-demo/playwright.config.ts` |
| DTLS trusts the signaling server, which relays each peer's certificate fingerprint. | `docs/application-e2ee.md`, `docs/threat-model.md` §5 |

## Open

| Finding | Where it showed up | Roadmap task |
|---|---|---|
| The SDK is not published (`private`, version `0.0.0`): the examples serve its source with the types stripped, and an application outside this repository has no package to install. | `examples/minimal-app/server.ts`, `examples/browser-demo/server.ts` | Phase 12: the `0.1.0` release (ADR 0043); until then, `docs/onboarding.md` and `packages/sdk/README.md#installation` say how to depend on it |
| No application outside this repository has integrated yet. | Phase 11 | Phase 11: integrate with BlindVault |

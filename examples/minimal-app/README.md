# Minimal app

The shortest complete use of the SDK: a page and its application backend on one origin. The
backend is `examples/backend-issuer`, imported as is; `server.ts` adds the page.

A device signs in, enrolls its `DeviceKey`, and connects with tokens bound to that key. A user's
first device joins the namespace `example:<user>`. A later device may only ask to be paired: it
presses **Ask to pair**, one of the user's devices presses **Approve**, and the new device takes
the approval to the backend, then reconnects with a token that holds the namespace. Devices in the
namespace list each other, and **Connect to** opens a DataChannel for messages.

`public/app.ts` is the whole client. The page loads the SDK from its
TypeScript sources, as `examples/browser-demo` does; an application bundles it instead.

## Running

```sh
cd examples/minimal-app

# A signing key and a registry trusting it, as in examples/backend-issuer
export BLINDSIGNAL_EXAMPLE_SIGNING_JWK="$(node ../backend-issuer/src/keygen.ts)"
node ../backend-issuer/src/registry.ts > ../backend-issuer/registry.json

# In another terminal, from the repository root: the signaling server, on port 8080
BLINDSIGNAL_ENV=development BLINDSIGNAL_REGISTRY_PATH="$PWD/examples/backend-issuer/registry.json" \
  pnpm --filter @blindsignal/server start

# The page and its backend, on http://127.0.0.1:4000
pnpm start
```

Open `http://127.0.0.1:4000` in two browser profiles, or one normal window and one private window:
a profile holds one device key and one device ID. Sign in as the same user in both, pair the
second, and connect.

The backend's variables are those of `examples/backend-issuer`; `BLINDSIGNAL_EXAMPLE_SIGNALING_URL`
(default `ws://localhost:8080`) is the signaling server the page uses.

## Tests

`pnpm test:browser` runs `tests/` with Playwright in Chromium and Firefox. `playwright.config.ts`
generates a key for the run, writes a registry trusting it, and starts the signaling server and
this server on their own ports. Two browser contexts are a user's two devices: the second is paired
by the first, and a message between them never crosses the signaling server.

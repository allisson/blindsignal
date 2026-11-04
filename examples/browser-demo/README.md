# Browser demo

Two browser tabs find each other through the signaling server and open a DataChannel. The page
loads the SDK straight from its TypeScript sources: `server.ts` strips the types as it serves them,
and an import map resolves the bare specifiers, so there is no bundler.

`server.ts` also stands in for the application backend: `/token` mints a token for the `notes`
application, or the one `&app` names, with the development issuer, whose private key is public in this repository. It
starts only with `BLINDSIGNAL_ENV=development`.

## Running

```sh
# From the repository root: the signaling server, on port 8080
BLINDSIGNAL_ENV=development BLINDSIGNAL_REGISTRY_PATH="$PWD/examples/registry.dev.json" \
  pnpm --filter @blindsignal/server start

# In another terminal: the demo, on http://127.0.0.1:3000
BLINDSIGNAL_ENV=development pnpm --filter @blindsignal/browser-demo start
```

Open `http://127.0.0.1:3000/?user=alice&device=laptop` and `http://127.0.0.1:3000/?user=bob&device=phone`,
then press **Connect to bob/phone** in the first tab. The demo accepts every session request.

`BLINDSIGNAL_DEMO_PORT` and `BLINDSIGNAL_DEMO_SIGNALING_URL` change the demo's port and the
signaling server it uses; a page takes no other one, so a link cannot send its tokens elsewhere. Add `&relay` to a
page's URL to connect through TURN only (`iceTransportPolicy: 'relay'`); the signaling server must
configure TURN (ADR 0017). `&connectTimeout=<ms>` sets the SDK's `connectTimeoutMs` (ADR 0018). `&pop` loads the origin's
device key and binds the page's tokens to it, as `cnf.jkt` (ADR 0041); the page shows the key's
thumbprint. `&pairing` makes the page a new device: its token lists `notes:demo` in `pairing`
instead of `namespaces`, and **Ask to pair** asks the user's other `&pop` pages in the namespace,
which approve every request (ADR 0042). The page shows the approval a backend would check.
`&app=chat` signs in to the `chat` application of `examples/registry.dev.json`, in `chat:demo`, and
`&binary` sends each message as UTF-8 bytes instead of a string.

## Tests

`pnpm test:browser` runs `tests/` with Playwright in Chromium, Firefox, and WebKit, starting both
servers on their own ports. Install the browsers once with
`pnpm --filter @blindsignal/browser-demo exec playwright install chromium firefox webkit`. WebKit
connects only through the TURN relay, so its DataChannel tests run with `BLINDSIGNAL_TEST_TURN=1`
(ADR 0047).

`BLINDSIGNAL_TEST_TURN=1 pnpm test:browser` also runs the relay tests: it starts the Coturn of
`compose.yaml` with Docker, on loopback, and three signaling servers with its test secret, each
offering one TURN transport: UDP, TCP, and TLS, and each with a demo page of its own, since a page
takes its server only from its configuration. Chromium accepts the self-signed TLS certificate
through `--ignore-certificate-errors`; Firefox has no such switch, so its TLS test is skipped. The
same run tests the fallback to the relay, in a Firefox that gathers no host candidates, and a
fourth signaling server whose TURN URL nothing listens on, with which sessions still connect
directly, and a session forced to that relay closes once the connection timeout runs out. CI runs the suite this way.

The proof-of-possession tests run in both browsers: pages with `&pop` authenticate with a device
key that a reload keeps, and a page whose proof is stripped on its way to the server is refused.
The pairing test opens two `&pop` pages of one user, one with `&pairing`, and checks that the
approval binds the new page's key and is signed by the other's. Another test runs `notes` and
`&app=chat&binary` pages with the same user and device IDs on one signaling server: each pair
exchanges its own kind of message, no frame names the other application's namespace, and no page
supersedes the other application's device.

# Browser demo

Two browser tabs find each other through the signaling server and open a DataChannel. The page
loads the SDK straight from its TypeScript sources: `server.ts` strips the types as it serves them,
and an import map resolves the bare specifiers, so there is no bundler.

`server.ts` also stands in for the application backend: `/token` mints a token for the `notes`
application with the development issuer, whose private key is public in this repository. It
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
signaling server it uses. Add `&relay` to a page's URL to connect through TURN only
(`iceTransportPolicy: 'relay'`); the signaling server must configure TURN (ADR 0017).

## Tests

`pnpm test:browser` runs `tests/` with Playwright in Chromium and Firefox, starting both servers
on their own ports. Install the browsers once with
`pnpm --filter @blindsignal/browser-demo exec playwright install chromium firefox`.

`BLINDSIGNAL_TEST_TURN=1 pnpm test:browser` also runs the relay test: it starts the Coturn of
`compose.yaml` with Docker, on loopback, and gives the signaling server its test secret. CI runs
it this way.

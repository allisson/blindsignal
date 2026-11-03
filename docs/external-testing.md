# External network testing

How to run BlindSignal on one machine and connect browsers on other networks to it (spec §14.2,
roadmap Phase 7). The setup is for development only: it trusts the development issuer, whose
private key is public in this repository, so anyone who learns a tunnel URL can mint a token.
Stop the tunnels when the test ends.

Cloudflare Quick Tunnel is the ingress here: it gives the local server a temporary HTTPS and WSS
address. It is not a WebRTC transport or a TURN relay. DataChannel traffic still flows directly
between the browsers, or not at all: TURN arrives in Phase 8.

## Local workflow with Docker Compose

`compose.yaml` builds the server image and runs it in development mode with
`examples/registry.dev.json`, publishing the signaling port `8080` and the admin port `9090` on the
host's loopback only.

```sh
docker compose up --build             # start; logs stream as JSON lines
curl -s http://127.0.0.1:8080/readyz  # 200 once the server accepts connections
curl -s http://127.0.0.1:9090/metrics # Prometheus counters and gauges
docker compose kill -s SIGHUP server  # reload examples/registry.dev.json after editing it
docker compose down                   # stop
```

Configuration is environment-driven: add variables from `apps/server/README.md` under
`environment` in `compose.yaml`. For the tunnel tests below, run the server with pnpm instead:
under Compose the server sees Docker's gateway as the TCP peer, not the loopback address that
the tunnel's trusted-proxy setting names.

## Exposing the server and the demo

The browser demo (`examples/browser-demo`) stands in for an application: it serves the page and
mints development tokens. Both it and the signaling server need a tunnel. Install `cloudflared`
(`brew install cloudflared` on macOS) and run each command below in its own terminal, from the
repository root.

```sh
# 1. Tunnel to the signaling server; note the https://<name>.trycloudflare.com address it prints
cloudflared tunnel --url http://127.0.0.1:8080

# 2. Tunnel to the demo; note its address too
cloudflared tunnel --url http://127.0.0.1:3000

# 3. The signaling server: cloudflared connects from loopback and sends CF-Connecting-IP
BLINDSIGNAL_ENV=development \
BLINDSIGNAL_REGISTRY_PATH="$PWD/examples/registry.dev.json" \
BLINDSIGNAL_TRUSTED_PROXIES=127.0.0.1 \
BLINDSIGNAL_FORWARDED_HEADER=cf-connecting-ip \
BLINDSIGNAL_ICE_SERVERS='[{"urls":["stun:stun.cloudflare.com:3478"]}]' \
  pnpm --filter @blindsignal/server start

# 4. The demo, pointed at the signaling tunnel (wss://, the address from step 1)
BLINDSIGNAL_ENV=development \
BLINDSIGNAL_DEMO_SIGNALING_URL=wss://<signaling-name>.trycloudflare.com \
  pnpm --filter @blindsignal/browser-demo start
```

Open `https://<demo-name>.trycloudflare.com/?user=alice&device=laptop` on one device and
`https://<demo-name>.trycloudflare.com/?user=bob&device=phone` on another, then press
**Connect to bob/phone** on the first. The tunnels use `127.0.0.1`, not `localhost`: the demo
listens on IPv4 loopback only, and the trusted proxy must match the address cloudflared connects
from.

In development mode with no `BLINDSIGNAL_ALLOWED_ORIGINS`, the server accepts every origin. To
exercise the origin check as well, set it to the demo's tunnel origin,
`https://<demo-name>.trycloudflare.com`.

## Checking the client IP

Pre-authentication limits are keyed by the client IP (ADR 0011). Through a tunnel, every
connection arrives from cloudflared on loopback, so without the trusted-proxy setting all clients
share one address and one set of limits.

- Each WebSocket connection logs `connection.opened` with an `ip` field. With step 3 as written,
  it is the client's public address, and two devices on different networks show different ones.
- Restarting the server without `BLINDSIGNAL_TRUSTED_PROXIES` makes every `ip` `127.0.0.1`: the
  header is ignored, as it must be from an untrusted peer.

## Scenarios

Run each scenario in Chromium and Firefox where the devices allow. Before each one, reload both
pages.

| ID | Scenario | How | Expected |
|---|---|---|---|
| S1 | Same machine | Two tabs on the machine running the server, through the demo tunnel | Each tab lists the other; the DataChannel opens; messages arrive both ways |
| S2 | Same network | Two devices on one Wi-Fi network | As S1; connection type `direct` |
| S3 | Different networks | One device on Wi-Fi, the other on mobile data or another Wi-Fi network | As S1 where the NATs allow a direct path; a failure is recorded, not retried with TURN |
| S4 | Invalid token | The command below, from any network | `{"version":1,"type":"error","requestId":"r1","payload":{"code":"invalid_token"}}`; the server logs `connection.error` with `invalid_token` and no `connection.authenticated` |
| S5 | WebSocket interruption | Stop the signaling server (Ctrl-C) for 10 seconds, then start it again | Signaling shows `connecting`, then `connected`; an open DataChannel stays open and keeps carrying messages, while the server-side session is gone (`blindsignal_sessions` 0); a new session opens on request |
| S6 | Network change | During an open session, switch the phone from Wi-Fi to mobile data | Record what happens: whether signaling reconnects, and whether the session survives or ends |

S4 sends a token that is not a JWT, with Node.js 26's built-in WebSocket. It sends no `Origin`
header, which the origin check lets through: only the token guards non-browser clients.

```sh
node -e "const ws = new WebSocket(process.argv[1]);
ws.onopen = () => ws.send(JSON.stringify({ version: 1, type: 'auth.authenticate', requestId: 'r1', payload: { token: 'not-a-token' } }));
ws.onmessage = (message) => { console.log(message.data); ws.close(); };" wss://<signaling-name>.trycloudflare.com
```

## ICE diagnostics

- The demo shows the connection type of the open session: `direct`, `relay`, or `unknown` until a
  candidate pair is selected. With STUN only, `relay` never appears; relay reporting is verified in
  Phase 8.
- Chromium: `chrome://webrtc-internals` lists each peer connection's ICE candidates, candidate
  pairs, and the selected pair. Firefox: `about:webrtc`. Save the page (Chromium's "Create dump",
  Firefox's "Save page") when a scenario fails.
- Note each selected candidate's type (`host`, `srflx`, `prflx`) in the report. Candidate
  addresses are personal data: keep the dumps out of the repository.

## Known limitations

- No TURN until Phase 8: two peers behind symmetric NATs, common on mobile carriers, may never
  find a direct path, and the session ends at the negotiation timeout.
- A Quick Tunnel address changes on every `cloudflared` start, and the demo reads the signaling
  address at startup: restart the demo with the new address after restarting tunnel 1.
- The demo accepts every session request and mints a token for any user it is asked for; an
  application must authenticate its users before issuing tokens (`docs/token-issuance.md`).
- A browser suspends a backgrounded page, mobile ones especially, so a PWA keeps no connection
  while inactive (spec §15).
- A network change that drops the WebSocket also ends the session: the device's new connection
  supersedes the old one (ADR 0008), and the server ends its sessions with `peer_disconnected`.
  If the DataChannel's path went with the old network, it closes, since an ICE restart needs the
  session; the application opens a new one (spec §15).
- The old connection of a device that changed networks stays open on the server until a missed
  heartbeat closes it with `1006`, about 30 seconds later; its sessions end earlier, when the new
  connection supersedes it.

## Connectivity test report

Copy this table into a new section of `docs/connectivity-report.md`, which records each run.

| ID | Date | Device A: browser, network | Device B: browser, network | Signaling | DataChannel | Connection type | Selected candidates | Notes |
|---|---|---|---|---|---|---|---|---|
| S1 | | | | | | | | |

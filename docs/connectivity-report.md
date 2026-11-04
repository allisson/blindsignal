# Connectivity test report

Results of the cross-network scenarios in `docs/external-testing.md` (roadmap Phase 7). Each run
adds a section; client addresses are described, never recorded.

## Run 1 — 2026-11-03

Setup: the guide's commands on one macOS machine, the signaling server and the browser demo each
behind a Cloudflare Quick Tunnel (`cloudflared` 2026.10.7), `stun:stun.cloudflare.com:3478` as the
only ICE server. Browsers: Chrome 156.0.8078.80 and Brave 1.98.62 on macOS, Chrome 156.0.8078.79 on
Android.

| ID | Device A | Device B | Signaling | DataChannel | Connection type | Notes |
|---|---|---|---|---|---|---|
| S1 | Chrome, macOS | Brave, same macOS machine | Authenticated through the tunnel | Open; messages both ways | direct | — |
| S2 | Chrome, macOS, home Wi-Fi | Chrome, Android, same Wi-Fi | Authenticated | Open; messages both ways | direct | The Android connection once closed with `1006` and reconnected 7 s later; cause not confirmed |
| S3 | Chrome, macOS, home Wi-Fi | Chrome, Android, mobile data | Authenticated; the phone arrived over IPv6 | Open; messages both ways | direct | The phone's new connection superseded its Wi-Fi one (ADR 0008) |
| S4 | Node.js 26 WebSocket | — | `invalid_token`; no `connection.authenticated` | — | — | — |
| S5 | Chrome, macOS, home Wi-Fi | Chrome, Android, mobile data | Server down 19 s; both clients reconnected on their own, 13 s and 17 s after it was back | Stayed open; messages both ways | direct | Server-side session gone (`blindsignal_sessions` 0), as `docs/protocol.md` prescribes |
| S6 | Chrome, macOS, home Wi-Fi | Chrome, Android, mobile data, then Wi-Fi | The phone reconnected over Wi-Fi; its old connection got `superseded` and closed with `1006` 30 s later | Closed | — | The session ended with `peer_disconnected`, so no ICE restart could recover the path; a new session is needed |

Findings:

- **Client IP through the tunnel.** `connection.opened` logged each client's public address, IPv4
  and IPv6 alike, not `127.0.0.1`: Cloudflare sends `CF-Connecting-IP`, and the server honors it
  from the trusted loopback connector.
- **Authorization.** Only demo-issued tokens authenticated; a malformed token got `invalid_token`.
- **Direct connections** formed on one machine, on one network, and between home Wi-Fi and mobile
  data.
- **A network change ends the session** when it drops the WebSocket (S6); the guide's known
  limitations record it.

Gaps, for a later run:

- No scenario ran in Firefox.
- No `chrome://webrtc-internals` dump was saved, so the selected candidate types (`host`, `srflx`)
  are unknown: S3 may have paired IPv6 host candidates rather than STUN-derived ones, and
  STUN-based negotiation is not yet shown.
- The `unknown` connection type was not checked before a candidate pair was selected.

## Run 2 — 2026-11-03

Closes run 1's gaps, with the same setup and new tunnel addresses. Browsers: Chrome
156.0.8078.80 and Firefox 159.0 on macOS, Chrome 156.0.8078.79 on Android.

| ID | Device A | Device B | Signaling | DataChannel | Connection type | Notes |
|---|---|---|---|---|---|---|
| S3 | Chrome, macOS, home Wi-Fi | Chrome, Android, mobile data | Authenticated | Open | `unknown`, then `direct` | Selected pair `srflx` ↔ `srflx`, IPv4, UDP |
| S3 | Firefox, macOS, home Wi-Fi | Chrome, Android, mobile data | Authenticated | Open; messages both ways | Not reported | — |

Findings:

- **STUN-based negotiation.** The peer connection's configuration held only
  `stun:stun.cloudflare.com:3478`, which the demo does not pass to the SDK: it came in
  `rtc.ice_config` (ADR 0009). The selected candidate pair, read with `getStats()`, was
  server-reflexive on both ends, IPv4 over UDP: the path came from STUN, not from host
  candidates. The macOS side gathered `host` candidates, their addresses hidden behind mDNS, and
  one `srflx`; the Android side sent `srflx` IPv4, `host` IPv6, and `host` IPv4.
- **Connection type.** Sampled every 20 ms, the demo showed `unknown` while connecting and `direct`
  once a pair was selected, before the DataChannel opened.
- **Firefox** opened a DataChannel to Chrome on Android across networks.
- **Backgrounded mobile page.** The Android connection closed with `1006` twice and reconnected
  once the page was in front again, as run 1's S2 and the guide's known limitations describe.

## Not yet run

No run has included Safari or an iOS device. Playwright's WebKit covers Safari's relay path in CI,
but not a direct one (ADR 0047): a run with a Safari device would.

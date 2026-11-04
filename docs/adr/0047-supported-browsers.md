# Supported browsers

**Status:** accepted

ADR 0001 required Chromium and Firefox in CI and left WebKit best-effort until roadmap Phase 12's
browser compatibility tests. ADR 0043 counts dropping a supported browser as a breaking change of
the SDK, so the supported browsers must be named before its first publication.

Running the Playwright suites in Playwright's WebKit 27.2 showed three things:

- **WebRTC works through a TURN relay:** DataChannels open over UDP and TCP relays, a non-extractable
  `DeviceKey` survives a reload in IndexedDB, and pairing, proof-of-possession, and application
  isolation pass.
- **Host candidates never connect.** WebKit names them with mDNS names (`<uuid>.local`) that it
  cannot resolve itself, and Playwright offers no switch to turn that off, as Chromium's
  `--disable-features=WebRtcHideLocalIpsWithMdns` and Firefox's
  `media.peerconnection.ice.obfuscate_host_addresses` do. A TURN relay over TLS with the test
  server's self-signed certificate fails too, even with `ignoreHTTPSErrors`.
- **WebKit drops a `Secure` cookie on plain-HTTP loopback,** which Chromium and Firefox keep: the
  minimal app's sign-in failed there.

## Rules

- **The SDK supports Chrome and Edge 119, Firefox 121, and Safari 17.4, and later,** on desktop and
  on iOS. These are the first versions with `Promise.withResolvers`, the newest API the SDK uses;
  the SDK also needs WebRTC DataChannels, WebCrypto ECDSA P-256, and, for `DeviceKey.load()`,
  IndexedDB keeping a `CryptoKey`. Raising a minimum is a breaking change (ADR 0043).
- **CI runs the Playwright suites in Chromium, Firefox, and WebKit.** In WebKit, a test that needs
  host candidates is skipped, and a test that opens a DataChannel runs only with the TURN relay,
  which CI starts. Each skip states its reason in the test.
- **iOS and direct connections in Safari are untested:** no automated test covers them, and
  `docs/external-testing.md` is where a run with a Safari device would cover them.
- **`examples/backend-issuer` leaves `Secure` out of its session cookie only for a plain-HTTP
  `localhost`, `127.0.0.1`, or `[::1]` origin,** where no network sees the cookie; every other
  origin keeps it.

## Considered options

- **"The last two major versions" of each browser, with no minimum.** Rejected: it says nothing
  about which APIs an application can count on, and changes with every browser release.
- **WebKit locally only.** Rejected: the relay path, `DeviceKey`, and pairing pass in it, and only
  CI keeps them passing.
- **The minimal app's tests over HTTPS,** with a self-signed certificate. Rejected: more setup,
  and a page on HTTPS cannot open the `ws://localhost` signaling server the suite runs.
- **Skipping the minimal app in WebKit.** Rejected: sign-in, pairing, and `refresh()` pass there;
  only the message exchange needs a relay the suite does not start.

## Consequences

- ADR 0001's browser line and ADR 0041's untested Safari key storage are amended by this record.
- CI's `browser` job installs WebKit too, and the job runs longer.
- A Linux runner's WebKit may behave unlike macOS's, where these results come from; a skip it
  needs is added with its reason.

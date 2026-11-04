# A private network with Tailscale

How to run BlindSignal and `examples/minimal-app` on one laptop and pair devices that join the
same tailnet. It is for development and personal testing, not production. These steps have not yet
been run end to end.

`tailscale serve` is the ingress: it gives the laptop's local ports an HTTPS address that only
devices in the tailnet can reach. It is not a WebRTC transport: DataChannel traffic does not use
the tailnet (see Limitations).

## Why HTTPS

A plain `http://100.x.y.z` address does not work. The SDK's `DeviceKey` needs `crypto.subtle` and
IndexedDB, which browsers offer only in a secure context, and the SDK refuses `ws://` except on a
loopback host. `tailscale serve` answers on `https://<machine>.<tailnet>.ts.net` with a certificate
browsers accept.

## Before you start

- Tailscale on the laptop and on every device, signed in to the same tailnet.
- MagicDNS and HTTPS certificates enabled in the tailnet's admin console (DNS page).
- The laptop's MagicDNS name, from the admin console or `tailscale status`, such as
  `laptop.tail1234.ts.net`.

## Running

From the repository root, with the commands of each step in their own terminal. Steps 1 and 2 need
the variables exported in step 0.

```sh
# 0. The laptop's name, a signing key for the example backend, and a registry trusting it
export HOST=laptop.tail1234.ts.net
export BLINDSIGNAL_EXAMPLE_SIGNING_JWK="$(node examples/backend-issuer/src/keygen.ts)"
export BLINDSIGNAL_EXAMPLE_ALLOWED_ORIGINS="https://$HOST"
node examples/backend-issuer/src/registry.ts > examples/backend-issuer/registry.json

# 1. The signaling server, on port 8080
BLINDSIGNAL_ENV=development \
BLINDSIGNAL_REGISTRY_PATH="$PWD/examples/backend-issuer/registry.json" \
BLINDSIGNAL_ALLOWED_ORIGINS="https://$HOST" \
BLINDSIGNAL_ICE_SERVERS='[{"urls":["stun:stun.cloudflare.com:3478"]}]' \
  pnpm --filter @blindsignal/server start

# 2. The page and its backend, on port 4000, pointed at the signaling address of step 3
BLINDSIGNAL_EXAMPLE_SIGNALING_URL="wss://$HOST:8443" \
  pnpm --filter @blindsignal/minimal-app start

# 3. HTTPS inside the tailnet: the page on 443, the signaling server on 8443
tailscale serve --bg 4000
tailscale serve --bg --https=8443 8080
tailscale serve status
```

Both servers check the page's origin: the backend refuses a `POST` from any origin outside
`BLINDSIGNAL_EXAMPLE_ALLOWED_ORIGINS`, and the signaling server checks `BLINDSIGNAL_ALLOWED_ORIGINS`
as defense in depth.

## Pairing

1. On the laptop, open `https://<HOST>` and sign in as a user, `alice` for instance. The first
   device joins the namespace `example:alice`.
2. On the phone, open the same address and sign in as `alice`. The page shows **Ask to pair**:
   press it.
3. On the laptop, press **Approve** with the phone's device ID. The phone reconnects with a token
   that holds the namespace, and each device lists the other.
4. Press **Connect to** on either device, then send a message.

A browser profile is a device: it keeps its key and device ID per origin. A new `HOST` makes every
browser a new device, paired again.

## Stopping

```sh
tailscale serve reset   # removes both HTTPS listeners
```

Then stop the processes of steps 1 and 2.

## Limitations

- **The DataChannel does not cross the tailnet.** Browsers hide their local addresses behind
  mDNS `.local` names, which do not resolve across the tailnet, so peers connect through the
  addresses STUN finds, as in scenario S3 of `docs/external-testing.md`. Two devices behind
  symmetric NATs, common on mobile carriers, may never connect; this setup has no TURN server.
- **Every device is `127.0.0.1` to the server.** `tailscale serve` connects from loopback, and the
  server trusts no forwarding header here, so all devices share the per-address limits: one
  authentication per second, with a burst of ten. A handful of devices stays under it; if
  reconnects return `rate_limited`, raise `BLINDSIGNAL_RATE_LIMIT_AUTHENTICATION` in step 1.
- **Anyone in the tailnet can sign in as anyone.** The example's `/login` stands in for an
  application's sign-in and accepts any user. Keep the tailnet to your own devices, and never use
  `tailscale funnel`, which would publish the page to the internet.
- The signaling server listens on every interface, so `http://<HOST>:8080` also answers inside
  the tailnet; the SDK never uses it, since it is not `wss://`.

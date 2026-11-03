# Application lifecycle

How an operator registers an application, changes it, and suspends or revokes it or one of its
devices. Every step edits the registry file, the control plane of
`docs/adr/0005-control-plane.md`; the server has no admin API. What the application's backend
must do is in `docs/token-issuance.md`, and its keys in `docs/secrets-and-keys.md`.

## Onboarding

1. **Collect from the backend team** the fields of the
   [registration table](token-issuance.md#registration): `appId`, `issuer`, `audience`, the
   `jwksUri` or the public keys, and the algorithms. Also the web origins its pages are served
   from, and the expected number of devices and concurrent connections.
2. **Check what they sent.** The issuer is an HTTPS URL the team controls and no other application
   uses. A `jwksUri` is HTTPS and answers within 5 seconds with public keys only. Static keys are
   `OKP` Ed25519 or `EC` P-256 JWKs with a unique `kid` and no private member (`d`).
3. **Add the entry** with `"status": "active"`, and `quotas` and `rateLimits` only where the
   expected load differs from the server defaults (`apps/server/README.md`):

   ```json
   {
     "appId": "blindnotes",
     "name": "BlindNotes",
     "status": "active",
     "issuer": "https://api.blindnotes.example",
     "audience": "blindsignal",
     "jwksUri": "https://api.blindnotes.example/.well-known/jwks.json",
     "algorithms": ["EdDSA"],
     "quotas": { "devices": 50000 }
   }
   ```

4. **Add its origins** to `BLINDSIGNAL_ALLOWED_ORIGINS`, an environment variable, so this step
   restarts or redeploys the server.
5. **Apply the change** ([below](#applying-a-registry-change)) and confirm `registry.reloaded` in the
   logs, or `registry.reload_rejected` with the field at fault.
6. **Have the team connect one device.** `blindsignal_authentications_total` and the
   `blindsignal_application_*` series on `/metrics` show its first authentication. A rejection
   reaches the client as one code, and `docs/token-issuance.md#rejections` lists what to check.

## Applying a registry change

The server reads the file at startup and on `SIGHUP`. A reload is all or nothing: an invalid file
leaves the current registry in force and logs `registry.reload_rejected` with the key at fault,
never a value.

- **One host:** edit the file, then `kill -HUP <pid>`, or `docker compose kill -s SIGHUP server`.
- **Several instances:** signal one instance; it stores the registry and the others install it
  through Redis, or at their next sync when Redis was down (ADR 0024). Every instance must read
  the same file, or a restarted instance loads its own copy.
- **Cloud Run and other hosts without signals:** a registry change is a new deployment. It
  restarts the instances, which close their connections; clients reconnect with new tokens.

## Changing an application

Edit its entry and apply the change. New quotas and rate limits reach each connection at its next
`auth.refresh`, within one token lifetime. Key changes follow `docs/secrets-and-keys.md`.

- **`issuer`:** from the reload on, every token with the old `iss` is rejected. Apply the change
  when the backend switches, or register a new application and move clients to it.
- **`appId`:** a new `appId` is a new application, with its own devices and quotas; tokens carry
  `app_id`, so the old one's clients fail until the backend changes it. Register the new one, move
  clients, then revoke the old one.

## Suspending and reactivating

Suspension is reversible. Use it for abuse (ADR 0016), an unpaid account, or a compromised key
while it is replaced.

- Set `"status": "suspended"` and apply. New authentications get `application_unavailable`, the
  application's connections close, and its sessions end.
- The SDK treats `application_unavailable` as terminal: it closes every session, established
  DataChannels included, and stops reconnecting (spec §6.4). The application decides when to
  create a new client.
- Set `"status": "active"` and apply to reactivate it. Only a suspended application reactivates.

## Revoking an application

Revocation is terminal. Set `"status": "revoked"` and apply: clients see what a suspension does,
and the application can never return to `active` or `suspended`. A reload that tries is rejected,
and with PostgreSQL storage an instance whose file tries does not start (ADR 0021).

- Keep the entry, with `"status": "revoked"`, in the file for good. Removed from the file, the
  application is removed from the stored registry at the next load too, and only the processes
  that saw it revoked keep refusing it until they restart (ADR 0021, `docs/backup-and-recovery.md`).
- To serve the same team again, register a new `appId` with a new issuer.

## Revoking a device

Revoke one device of one user, for a lost or stolen device:

```json
"revokedDevices": [{ "userId": "user_123", "deviceId": "device_456" }]
```

Apply the change. The device's connections close, its new authentications get `device_revoked`,
and the peers of its sessions get `session.terminated` with `peer_revoked`. The backend should also
stop issuing tokens for it. Removing the entry, and applying, lets the device authenticate again.

## What revocation cannot reach

Once a DataChannel is open, payloads flow between the browsers, not through the server
(spec §6.4). A suspension or revocation closes signaling connections and the SDK closes its
sessions, but a modified client can keep an established direct connection open, and a relayed one
lasts while its client refreshes the allocation (ADR 0017). An application that needs a hard cut
rotates its own end-to-end keys on revocation.

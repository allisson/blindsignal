# Adapter interfaces and MVP data model

**Status:** accepted

Spec §10 sketches `StorageAdapter` with five repositories and lists what `CoordinationAdapter`
holds, without fixing either contract. The MVP keeps only the storage it uses, makes every adapter
method asynchronous, and gives `CoordinationAdapter` domain operations rather than generic
primitives, so business logic never assembles concurrency protocols out of key-value calls.

## StorageAdapter

```typescript
interface StorageAdapter {
  applications: ApplicationRepository;
  devices: DeviceRepository;
}
```

- **Only what the MVP uses.** Namespace policy lives in the token and the registry holds none
  (ADR 0007), so `namespaces` and `authorization` repositories are not part of the MVP. `pairings`
  arrives with pairing (spec §7.4). Each repository is added with the feature that needs it.
- **`applications`** holds the §5.1 records and, per application, the revoked devices. The
  registry loader (ADR 0005) writes the whole validated registry through it at startup and on
  every reload; the repository replaces its content atomically, so readers never see a partial
  registry. It is read by `app_id` and by issuer.
- **`devices`** holds one record per `(app_id, sub, device_id)`: the triple, when it first
  authenticated, and when it last authenticated. A successful authentication creates or touches
  the record in one atomic call that also checks the application's device-count quota, so
  concurrent first authentications cannot exceed it.
- **Device records expire** after a configurable inactivity period since the last authentication,
  30 days by default. The device-count quota counts only live records, so a user minting new
  `device_id`s cannot exhaust it permanently. Revocations stay in the registry file (ADR 0005),
  never in device records, so expiry never forgets one.

## CoordinationAdapter

Each operation is atomic and maps to one Redis script or transaction in a future distributed
adapter:

- **`claimJti(iss, jti, ttl)`**: records the pair and reports whether it was new (ADR 0006).
- **`claimDeviceConnection(device, connectionId)`**: makes the connection the device's only one
  and returns the one it replaced, if any (ADR 0008). `releaseDeviceConnection` removes the claim
  when that connection closes.
- **Presence leases**: acquire, renew, and release a device's presence in a namespace, and list
  the live leases of a namespace. Leases expire on their own, so a lost instance leaves no
  permanent presence (spec §10.2).
- **`consumeRateLimit(key, policy)`**: takes one token from the key's bucket and reports whether
  it was allowed and, if not, when to retry.
- **Concurrency slots**: acquire slots under their limits, all or none, and release them, for the
  concurrent connection and session quotas. A session takes the application's slot and both
  devices' slots in one call (ADR 0011).
- **Releases name the holder**: the connection that holds a device claim or a presence lease, or
  the holder of a slot. A release by a stale holder, such as a superseded connection closing after
  its replacement joined, has no effect, and releasing twice is harmless.
- **`publish(topic, event)` / `subscribe(topic, handler)`**: signaling event delivery to the
  instance holding a connection, and application status propagation.

## Rules

- **Every method returns a `Promise`,** in-memory adapters included, so the PostgreSQL and Redis
  adapters replace them without changing callers.
- **Generic primitives were rejected** (a key-value store with TTL, atomic increment, pub/sub):
  each domain operation would become a multi-step protocol in business logic, with its race
  conditions repeated in every caller.

## Consequences

- Phase 9 finalizes both contracts against PostgreSQL and Redis; a missing operation is added
  there, not emulated with existing ones.
- On restart, in-memory device records are lost and devices re-enroll on their next
  authentication; the device-count quota starts empty.

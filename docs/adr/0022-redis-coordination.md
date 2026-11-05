# Redis-compatible coordination

**Status:** accepted

ADR 0019 chose the `redis` client and Valkey for `adapters/coordination/redis`. This ADR fixes how
that adapter keeps the `CoordinationAdapter` state of ADR 0010, so several server instances share
it, and the two changes to the contract that sharing needs. Wiring the server to it is a separate
Phase 9 task.

## Rules

- **The client is `@redis/client`,** the core package of node-redis that `redis` re-exports. It has
  every command the adapter uses, without the modules (JSON, search, time series, Bloom) that
  `redis` also installs.
- **One clock: the server's.** Every script reads `TIME`, and every expiry is a `PX` or a sorted-set
  score in that clock, so instances whose clocks drift still agree on what is live. The in-memory
  adapter keeps the clock it is given.
- **Each operation is one command, one script, or one transaction** (ADR 0019): `SET NX PX` for a
  `jti`, `SET GET PX` for a device's connection, Lua scripts for presence, rate limits, slots, and
  releases by holder, and a `MULTI` for releasing slots. Scripts run by their SHA1 and are sent
  again when the server answers `NOSCRIPT`, after a restart or a `SCRIPT FLUSH`.
- **Every key expires on its own.** Presence and slots are sorted sets scored by expiry, pruned
  whenever they are written, with a key TTL no shorter than their longest member; a rate-limit
  bucket lives until it is full again; a `jti` until its TTL. A device's connection claim is a
  lease too (amended with the coordination fixes of the Phase 12 security review):
  `claimDeviceConnection` takes it for `ttlMs`, and `renewDeviceConnection` extends it on every
  heartbeat while the connection holds it, or takes it again once it expired. Renewing fails while
  another connection holds it: the connection closes with `superseded`, as when that connection's
  event reaches it. Before, the claim had no TTL, and a device that never reconnected kept a lost
  instance's claim, and its key, for ever.
- **Slots are leases (contract change).** `acquireSlots(holder, slots, ttlMs)` takes the slots for
  `ttlMs`, and acquiring again renews them. The server renews the connection's slot and its
  sessions' slots on every heartbeat, with the presence lease's duration
  (`BLINDSIGNAL_PRESENCE_LEASE_SECONDS`), so an instance that stops leaves no slot held once its
  leases run out. A slot that expired and was taken meanwhile is not renewed: the connection
  closes with `quota_exceeded`, or the session ends with `timeout` (amended by the Phase 12 abuse
  review; before, the connection kept running outside the quota).
- **Events are JSON, delivered at most once (contract change).** `publish` sends
  `JSON.stringify(event)` on a channel per topic; each instance holds one subscriber connection
  for all its topics, and every subscriber receives a copy. An event published while an instance
  is disconnected is lost, as the protocol's events already allow: presence is listed again on
  discovery, and a session whose peer missed an event times out.
- **Keys and channels start with a prefix,** `blindsignal:` by default, so deployments can share a
  server and each test runs under a prefix of its own. Amended by the Phase 12 security review:
  `BLINDSIGNAL_REDIS_PREFIX` sets it, one per deployment, since pub/sub ignores the database
  number and a database of its own does not keep a deployment apart.
- **Presence answers one device, or one user, without listing the namespace** (amended by the
  Phase 12 abuse review). `isPresent(namespace, device)` reads the device's score; `listPresence`
  with a `userId` reads a sorted set per namespace and user, which the presence scripts keep with
  the namespace's own. `session.create` checks its target, and `pairing.create` lists its user's
  devices, at a cost that no longer grows with the namespace.
- **Standalone or Sentinel, never Cluster.** `acquireSlots` spans an application's and two
  devices' keys in one script, which Cluster refuses across hash slots.
- **Testing:** one contract suite in `@blindsignal/core/testing` runs against the in-memory adapter
  on every `pnpm test` and against Valkey when `BLINDSIGNAL_TEST_REDIS_URL` is set. Expiry
  boundaries stay in each adapter's own tests; the Redis tests add key expiry, script reloading,
  concurrent slots on two instances, and cross-instance delivery.

## Considered options

- **The caller's clock,** passed to every script. Rejected: a fast instance would expire the
  leases of the others.
- **Slots without expiry,** with stale holders found by an instance registry and heartbeats.
  Rejected: a second mechanism for what a lease already does for presence.
- **Redis Streams for events.** Rejected: consumer groups, trimming, and acknowledgements, for
  events no caller needs to replay.
- **Cluster with hash tags by application.** Rejected: the server would build keys for the
  adapter's sake, and namespaces and topics would need tags too.

## Consequences

- A connection that stops answering pings keeps its slots for up to one lease, as it keeps its
  presence.
- An instance that loses its Redis connection fails the operations it attempts; the connection
  that attempted one closes with `server_error` (ADR 0021).
- Moving to Cluster later needs a new key layout and a new ADR.
